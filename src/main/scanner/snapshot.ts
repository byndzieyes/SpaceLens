import type { FileEntry } from '../../shared/scan'
import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  type ScanDirectoryPage,
  type ScanDirectoryRequest,
  type ScanEntryRequest,
  type ScanSnapshot,
  type ScanSnapshotAvailability,
  type SnapshotAccessErrorCode
} from '../../shared/snapshot'
import type { ScanOutputEvent, ScanSummaryEvent } from './summary'

export interface SnapshotLimits {
  readonly maxEntries: number
  readonly maxEstimatedBytes: number
}

/** Per snapshot; at most one published and one building snapshot exist.
 * Estimate: 512 bytes per entry/index + twice the string lengths. This is a
 * retention budget, not an exact V8 heap measurement. Individual entries are
 * capped at 64 KiB, so a 100-entry IPC page is bounded too.
 */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxEntries: 100_000,
  maxEstimatedBytes: 64 * 1024 * 1024
}
const MAX_ENTRY_BYTES = 64 * 1024
type UnavailableReason = NonNullable<ScanSnapshotAvailability['unavailable']>['reason']

export class SnapshotAccessError extends Error {
  constructor(
    readonly code: SnapshotAccessErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SnapshotAccessError'
  }
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

/** Shared by Main callers and IPC; exact keys prevent accidental path-based requests. */
export function validateSnapshotRequest(
  request: ScanEntryRequest | ScanDirectoryRequest,
  directory: boolean
): void {
  const keys = directory ? ['scanId', 'entryId', 'offset', 'limit'] : ['scanId', 'entryId']
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(request, key)) ||
    !id(request.scanId) ||
    !id(request.entryId) ||
    (directory &&
      (!integer((request as ScanDirectoryRequest).offset) ||
        !integer((request as ScanDirectoryRequest).limit) ||
        (request as ScanDirectoryRequest).limit < 1 ||
        (request as ScanDirectoryRequest).limit > MAX_SCAN_DIRECTORY_PAGE_SIZE))
  )
    throw new SnapshotAccessError(
      'INVALID_REQUEST',
      'Valid snapshot IDs and bounded pagination are required.'
    )
}

interface DirectoryIndex {
  children: string[]
  knownBytes: number
  pendingDirectories: number
}

/** Incremental builder, sealed before publication. No event history or tree copies. */
export class ScanSnapshotStorage {
  private readonly entries = new Map<string, FileEntry>()
  private readonly directories = new Map<string, DirectoryIndex>()
  private rootId: string | null = null
  private estimatedBytes = 0
  private files = 0
  private errors = 0
  private finalized = 0
  private unknownMetadata = false
  private metadata: ScanSnapshot | null = null
  private failure: UnavailableReason | null = null

  constructor(
    readonly scanId: string,
    private readonly rootPath: string,
    private readonly limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS
  ) {
    if (!integer(limits.maxEntries) || !integer(limits.maxEstimatedBytes))
      throw new RangeError('Snapshot limits must be non-negative safe integers.')
  }

  get unavailableReason(): UnavailableReason | null {
    return this.failure
  }

  discard(reason: UnavailableReason = 'invalid-data'): void {
    this.entries.clear()
    this.directories.clear()
    this.metadata = null
    this.estimatedBytes = 0
    this.failure = reason
  }

  accept(event: ScanOutputEvent): void {
    if (this.failure || this.metadata) return
    if (event.type === 'summary') return // Validated at worker settlement, not publication here.
    if (event.type === 'error') {
      this.errors++
      return
    }
    const entry = event.entry
    const invalid = (): void => this.discard('invalid-data')
    if (entry.scanId !== this.scanId || !id(entry.id)) return invalid()
    if (event.type === 'directory-finalized') {
      const previous = this.entries.get(entry.id)
      const index = this.directories.get(entry.id)
      if (
        !previous ||
        !index ||
        previous.aggregatedSizeBytes !== null ||
        !integer(entry.aggregatedSizeBytes) ||
        entry.aggregatedSizeBytes !== index.knownBytes ||
        index.pendingDirectories !== 0 ||
        (Object.keys(previous) as (keyof FileEntry)[]).some(
          (key) => key !== 'aggregatedSizeBytes' && previous[key] !== entry[key]
        )
      )
        return invalid()
      this.entries.set(entry.id, { ...previous, aggregatedSizeBytes: entry.aggregatedSizeBytes })
      this.finalized++
      if (entry.parentId !== null) {
        const parent = this.directories.get(entry.parentId)!
        if (entry.aggregatedSizeBytes > Number.MAX_SAFE_INTEGER - parent.knownBytes)
          return invalid()
        parent.knownBytes += entry.aggregatedSizeBytes
        parent.pendingDirectories--
      }
      return
    }
    if (
      this.entries.has(entry.id) ||
      entry.aggregatedSizeBytes !== null ||
      !['file', 'directory', 'symlink', 'other', 'unknown'].includes(entry.type) ||
      (entry.sizeBytes !== null && (entry.type !== 'file' || !integer(entry.sizeBytes))) ||
      typeof entry.path !== 'string' ||
      typeof entry.name !== 'string' ||
      (entry.createdAt !== null && typeof entry.createdAt !== 'string') ||
      (entry.modifiedAt !== null && typeof entry.modifiedAt !== 'string')
    )
      return invalid()
    const parent = entry.parentId === null ? null : this.entries.get(entry.parentId)
    if (entry.parentId === null) {
      if (this.rootId !== null || entry.type !== 'directory' || entry.path !== this.rootPath)
        return invalid()
    } else if (!parent || parent.type !== 'directory' || parent.aggregatedSizeBytes !== null)
      return invalid()
    // Project only contract fields: no extra worker payload can escape the retention budget.
    const retained: FileEntry = {
      id: entry.id,
      scanId: entry.scanId,
      parentId: entry.parentId,
      path: entry.path,
      name: entry.name,
      type: entry.type,
      sizeBytes: entry.sizeBytes,
      aggregatedSizeBytes: null,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt
    }
    const bytes =
      512 +
      Object.values(retained).reduce<number>(
        (sum, value) => sum + (typeof value === 'string' ? value.length * 2 : 0),
        0
      )
    if (
      bytes > MAX_ENTRY_BYTES ||
      this.entries.size >= this.limits.maxEntries ||
      bytes > this.limits.maxEstimatedBytes - this.estimatedBytes
    )
      return this.discard('limit-exceeded')
    this.estimatedBytes += bytes
    this.entries.set(entry.id, retained)
    if (entry.parentId === null) this.rootId = entry.id
    else {
      const index = this.directories.get(entry.parentId)!
      index.children.push(entry.id)
      if (entry.type === 'directory') index.pendingDirectories++
      if (entry.type === 'file' && entry.sizeBytes !== null) {
        if (entry.sizeBytes > Number.MAX_SAFE_INTEGER - index.knownBytes) return invalid()
        index.knownBytes += entry.sizeBytes
      }
    }
    if (entry.type === 'directory')
      this.directories.set(entry.id, { children: [], knownBytes: 0, pendingDirectories: 0 })
    if (entry.type === 'file') this.files++
    if (entry.type === 'unknown' || (entry.type === 'file' && entry.sizeBytes === null))
      this.unknownMetadata = true
  }

  /** Called only after successful worker settlement; false never replaces a published snapshot. */
  complete(result: ScanSummaryEvent, completedAt: string): boolean {
    if (this.failure || this.metadata) return false
    const root = this.rootId === null ? undefined : this.entries.get(this.rootId)
    if (
      !root ||
      result.scanId !== this.scanId ||
      result.rootEntryId !== root.id ||
      this.finalized !== this.directories.size ||
      root.aggregatedSizeBytes === null ||
      result.summary.totalBytes !== root.aggregatedSizeBytes ||
      result.summary.fileCount !== this.files ||
      result.summary.directoryCount !== this.directories.size ||
      result.summary.errorCount !== this.errors ||
      (this.unknownMetadata && this.errors === 0)
    ) {
      this.discard('invalid-data')
      return false
    }
    for (const { children } of this.directories.values()) {
      children.sort((a, b) => {
        const left = this.entries.get(a)!.name
        const right = this.entries.get(b)!.name
        return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0
      })
    }
    this.metadata = {
      entries: { scanId: this.scanId, rootEntryId: root.id },
      root,
      completedAt,
      summary: { ...result.summary },
      entryCount: this.entries.size,
      incomplete: this.errors > 0
    }
    return true
  }

  describe(): ScanSnapshot {
    if (!this.metadata)
      throw new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'Snapshot is unavailable.')
    return {
      ...this.metadata,
      entries: { ...this.metadata.entries },
      root: { ...this.metadata.root },
      summary: { ...this.metadata.summary }
    }
  }

  getEntry(entryId: string): FileEntry {
    this.describe()
    const entry = this.entries.get(entryId)
    if (!entry)
      throw new SnapshotAccessError('ENTRY_NOT_FOUND', 'Entry does not exist in this snapshot.')
    return { ...entry }
  }

  listDirectory(request: ScanDirectoryRequest): ScanDirectoryPage {
    const entry = this.getEntry(request.entryId)
    if (entry.type !== 'directory')
      throw new SnapshotAccessError('NOT_DIRECTORY', 'Entry is not a directory.')
    const children = this.directories.get(entry.id)!.children
    const end =
      request.offset + Math.min(request.limit, Math.max(0, children.length - request.offset))
    return {
      scanId: this.scanId,
      directoryId: entry.id,
      entries: children.slice(request.offset, end).map((id) => ({ ...this.entries.get(id)! })),
      totalCount: children.length,
      nextOffset: end < children.length ? end : null
    }
  }
}
