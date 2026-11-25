import type { ScannerIpcResult } from '../../../../shared/ipc'
import type { FileEntry } from '../../../../shared/scan'
import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  type ScanDirectoryPage,
  type ScanDirectoryRequest,
  type ScanEntryRequest,
  type ScanSnapshot,
  type ScanSnapshotAvailability
} from '../../../../shared/snapshot'

export function isStaleSnapshotError(code?: string): boolean {
  return code === 'SNAPSHOT_EXPIRED' || code === 'SNAPSHOT_UNAVAILABLE'
}

export type ExplorerAccessError = Extract<ScannerIpcResult<never>, { ok: false }>['error']
export const invalidExplorerEntry = (message: string): ExplorerAccessError => ({
  code: 'INVALID_REQUEST',
  message
})

export interface LocatedContentsPage {
  readonly offset: number
  readonly page: ScanDirectoryPage
}

/** Availability at query time, not a guarantee that a later request will succeed. */
export type ExplorerSnapshotState =
  | {
      readonly status: 'available'
      readonly snapshot: ScanSnapshot
    }
  | { readonly status: 'missing'; readonly snapshot: null }

/**
 * Resolve the adopted SQLite snapshot without loading its children.
 * Its entries.scanId and root.id identify the explorable root. A completed
 * scan summary alone does not identify a browsable snapshot.
 *
 * For entry details, use window.spaceLens.getScanEntry({ scanId, entryId })
 * directly: it already returns ScannerIpcResult<FileEntry>. Keep IDs from the
 * same snapshot, and handle SNAPSHOT_EXPIRED without silently switching scans.
 * Structured failures and rejected transport promises are preserved unchanged.
 */
export async function resolveExplorerSnapshot(
  load: () => Promise<ScannerIpcResult<ScanSnapshotAvailability>> = window.spaceLens.getScanSnapshot
): Promise<ScannerIpcResult<ExplorerSnapshotState>> {
  const result = await load()
  if (!result.ok) return result
  const { snapshot } = result.value
  if (snapshot) return { ok: true, value: { status: 'available', snapshot } }
  return { ok: true, value: { status: 'missing', snapshot: null } }
}

/**
 * Fetch exactly one page, defaulting to the first 100 direct children.
 * Follow nextOffset explicitly with the same IDs; never treat one page as a
 * complete directory. Main's UTF-16 name/ID order and page metadata pass
 * through unchanged. No cache, prefetch, sorting, or snapshot-sized collection.
 */
export async function listExplorerDirectoryPage(
  directory: ScanEntryRequest,
  pagination: Partial<Pick<ScanDirectoryRequest, 'offset' | 'limit'>> = {}
): Promise<ScannerIpcResult<ScanDirectoryPage>> {
  const { offset = 0, limit = MAX_SCAN_DIRECTORY_PAGE_SIZE } = pagination
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_SCAN_DIRECTORY_PAGE_SIZE
  ) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: `Offset must be a non-negative safe integer and limit must be an integer from 1 to ${MAX_SCAN_DIRECTORY_PAGE_SIZE}.`
      }
    }
  }
  return window.spaceLens.listScanDirectory({
    scanId: directory.scanId,
    entryId: directory.entryId,
    offset,
    limit
  })
}

export async function resolveDirectoryAncestry(
  snapshot: ScanSnapshot,
  entryId: string,
  isCurrent: () => boolean
): Promise<FileEntry[] | undefined> {
  const chain: FileEntry[] = []
  const seen = new Set<string>()
  let id: string | null = entryId
  while (id !== null && chain.length < snapshot.summary.directoryCount) {
    if (seen.has(id)) throw invalidExplorerEntry('Directory ancestry contains a cycle.')
    seen.add(id)
    let entry: FileEntry
    if (id === snapshot.root.id) entry = snapshot.root
    else {
      const result = await window.spaceLens.getScanEntry({
        scanId: snapshot.entries.scanId,
        entryId: id
      })
      if (!isCurrent()) return
      if (!result.ok) throw result.error
      entry = result.value
    }
    if (entry.scanId !== snapshot.entries.scanId || entry.id !== id)
      throw invalidExplorerEntry('Entry identity does not match this snapshot.')
    if (entry.type !== 'directory')
      throw {
        code: 'NOT_DIRECTORY',
        message: 'Only directories can be opened.'
      } satisfies ExplorerAccessError
    chain.push(entry)
    if (id === snapshot.root.id) return chain.reverse()
    id = entry.parentId
  }
  throw invalidExplorerEntry('Directory ancestry could not be resolved within the snapshot root.')
}

/** Read a single key at page boundaries, then materialize only the page that contains the file. */
export async function locateFileContentsPage(
  directory: ScanEntryRequest,
  file: FileEntry,
  isCurrent: () => boolean
): Promise<LocatedContentsPage | undefined> {
  const pageSize = MAX_SCAN_DIRECTORY_PAGE_SIZE
  const read = async (offset: number, limit: number): Promise<ScanDirectoryPage | undefined> => {
    const result = await listExplorerDirectoryPage(directory, { offset, limit })
    if (!isCurrent()) return
    if (!result.ok) throw result.error
    if (result.value.scanId !== directory.scanId || result.value.directoryId !== directory.entryId)
      throw invalidExplorerEntry('Directory page identity does not match this snapshot.')
    return result.value
  }
  const first = await read(0, 1)
  if (!first) return
  let left = 1
  let right = Math.ceil(first.totalCount / pageSize) - 1
  let offset = 0
  while (left <= right) {
    const middle = left + Math.floor((right - left) / 2)
    const boundary = await read(middle * pageSize, 1)
    if (!boundary) return
    const entry = boundary.entries[0]
    if (!entry) throw invalidExplorerEntry('A directory page boundary is missing.')
    // Names use UTF-16 code-unit order. The storage contract restricts IDs to ASCII.
    if (entry.name < file.name || (entry.name === file.name && entry.id <= file.id)) {
      offset = middle * pageSize
      left = middle + 1
    } else right = middle - 1
  }

  const page = first.totalCount <= 1 ? first : await read(offset, pageSize)
  if (!page) return
  if (!page.entries.some(({ id }) => id === file.id))
    throw {
      code: 'ENTRY_NOT_FOUND',
      message: 'The file was not found in its containing directory.'
    } satisfies ExplorerAccessError
  return { offset, page }
}
