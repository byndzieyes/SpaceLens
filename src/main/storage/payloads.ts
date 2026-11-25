import { isAbsolute } from 'node:path'
import type { SnapshotDeletionResult } from '../../shared/history'
import type { FileEntry, ScanSession, ScanSummary } from '../../shared/scan'
import { SCANNER_BATCH_SIZE } from '../scanner/workerProtocol'

export type FinalizedDirectory = FileEntry & {
  readonly type: 'directory'
  readonly aggregatedSizeBytes: number
}

export type StorageBatchOperation =
  | { readonly type: 'entry'; readonly entry: FileEntry }
  | { readonly type: 'directory-finalized'; readonly entry: FinalizedDirectory }

export interface StorageBatch {
  readonly scanId: string
  readonly operations: readonly StorageBatchOperation[]
}

export type BuildingScan = ScanSession & { readonly status: 'running' }
export type CompletedScan = ScanSession & { readonly status: 'completed' }

export interface CommittedSnapshotDeletion extends SnapshotDeletionResult {
  readonly latestCompleted: CompletedScan | null
}

export interface ScanPublication {
  readonly scan: CompletedScan
  readonly rootEntryId: string
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

export function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export function isScanSummary(value: unknown): value is ScanSummary {
  return (
    record(value) &&
    integer(value.fileCount) &&
    integer(value.directoryCount) &&
    integer(value.totalBytes) &&
    integer(value.errorCount)
  )
}

export function isStorageScan(value: unknown): value is ScanSession {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.rootPath)) return false
  const { status, summary, startedAt, finishedAt } = value
  return (
    typeof startedAt === 'string' &&
    (status === 'running'
      ? finishedAt === null
      : (status === 'completed' || status === 'cancelled' || status === 'failed') &&
        typeof finishedAt === 'string') &&
    isScanSummary(summary)
  )
}

export function isSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function timestamp(value: string): number {
  const match =
    /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value
    )
  if (!match) return NaN
  // Date.parse can normalize an invalid calendar day instead of rejecting it.
  const day = new Date(`${match[1]}T00:00:00Z`)
  return Number.isFinite(day.getTime()) && day.toISOString().split('T')[0] === match[1]
    ? Date.parse(value)
    : NaN
}

export function validateBuildingScan(value: unknown): asserts value is BuildingScan {
  if (
    !isStorageScan(value) ||
    value.status !== 'running' ||
    !isSnapshotId(value.id) ||
    !isAbsolute(value.rootPath) ||
    !Number.isFinite(timestamp(value.startedAt))
  )
    throw new TypeError('A building scan requires valid running scan metadata.')

  const { fileCount, directoryCount, totalBytes, errorCount } = value.summary
  if (fileCount !== 0 || directoryCount !== 0 || totalBytes !== 0 || errorCount !== 0) {
    throw new TypeError('A building scan must start with an empty summary.')
  }
}

function completedDuration(scan: unknown): number {
  if (
    !isStorageScan(scan) ||
    scan.status !== 'completed' ||
    !isSnapshotId(scan.id) ||
    !isAbsolute(scan.rootPath)
  ) {
    throw new TypeError('Scan publication requires valid completed scan metadata and summary.')
  }
  const duration = timestamp(scan.finishedAt) - timestamp(scan.startedAt)
  if (!(duration >= 0)) {
    throw new TypeError('Scan publication requires valid timestamps in start-to-finish order.')
  }
  return duration
}

export function validateScanPublication(value: unknown): asserts value is ScanPublication {
  if (!record(value) || !isSnapshotId(value.rootEntryId)) {
    throw new TypeError('Scan publication requires a valid root entry ID.')
  }
  completedDuration(value.scan)
}

export function readCompletedScanDuration(scan: CompletedScan): number {
  const duration = completedDuration(scan)
  if (!integer(duration) || scan.summary.directoryCount === 0) {
    throw new Error('Invalid completed scan duration or directory count.')
  }
  return duration
}

export function isStorageEntry(value: unknown): value is FileEntry {
  if (!record(value)) return false
  const { id, scanId, parentId, path, name, type, createdAt, modifiedAt } = value
  return (
    nonempty(id) &&
    nonempty(scanId) &&
    (parentId === null || nonempty(parentId)) &&
    nonempty(path) &&
    typeof name === 'string' &&
    (type === 'file' ||
      type === 'directory' ||
      type === 'symlink' ||
      type === 'other' ||
      type === 'unknown') &&
    (value.sizeBytes === null || (type === 'file' && integer(value.sizeBytes))) &&
    (value.aggregatedSizeBytes === null ||
      (type === 'directory' && integer(value.aggregatedSizeBytes))) &&
    nullableString(createdAt) &&
    nullableString(modifiedAt)
  )
}

/** Empty batches are valid after filtering a scanner batch that only carried errors or a summary. */
export function validateStorageBatch(value: unknown): asserts value is StorageBatch {
  if (!record(value) || !isSnapshotId(value.scanId) || !Array.isArray(value.operations)) {
    throw new TypeError('A storage batch requires a scan ID and an operations array.')
  }
  const operations: readonly unknown[] = value.operations
  if (operations.length > SCANNER_BATCH_SIZE) {
    throw new RangeError(`A storage batch may contain at most ${SCANNER_BATCH_SIZE} operations.`)
  }
  for (const [index, operation] of operations.entries()) {
    if (!record(operation) || !isStorageEntry(operation.entry)) {
      throw new TypeError(`Invalid entry in storage batch operation ${index + 1}.`)
    }
    const { entry, type } = operation
    if (!isSnapshotId(entry.id) || (entry.parentId !== null && !isSnapshotId(entry.parentId))) {
      throw new TypeError(`Invalid entry reference in storage batch operation ${index + 1}.`)
    }
    if (entry.scanId !== value.scanId) {
      throw new TypeError(`Storage batch operation ${index + 1} belongs to a different scan.`)
    }
    if (type === 'entry' && entry.aggregatedSizeBytes === null) continue
    if (
      type === 'directory-finalized' &&
      entry.type === 'directory' &&
      entry.aggregatedSizeBytes !== null
    )
      continue
    throw new TypeError(
      `Invalid discovery or finalization in storage batch operation ${index + 1}.`
    )
  }
}
