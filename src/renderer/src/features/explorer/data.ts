import type { ScannerIpcResult } from '../../../../shared/ipc'
import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  type ScanDirectoryPage,
  type ScanDirectoryRequest,
  type ScanEntryRequest,
  type ScanSnapshot
} from '../../../../shared/snapshot'

export function isStaleSnapshotError(code?: string): boolean {
  return code === 'SNAPSHOT_EXPIRED' || code === 'SNAPSHOT_UNAVAILABLE'
}

/** Availability at query time, not a guarantee that a later request will succeed. */
export type ExplorerSnapshotState =
  | {
      readonly status: 'available'
      readonly snapshot: ScanSnapshot
    }
  | { readonly status: 'missing'; readonly snapshot: null }

/**
 * Resolve the published SQLite snapshot without loading its children.
 * Its entries.scanId and root.id identify the explorable root. A completed
 * scan summary alone does not identify a browsable snapshot.
 *
 * For entry details, use window.spaceLens.getScanEntry({ scanId, entryId })
 * directly: it already returns ScannerIpcResult<FileEntry>. Keep IDs from the
 * same snapshot, and handle SNAPSHOT_EXPIRED without silently switching scans.
 * Structured failures and rejected transport promises are preserved unchanged.
 */
export async function resolveExplorerSnapshot(): Promise<ScannerIpcResult<ExplorerSnapshotState>> {
  const result = await window.spaceLens.getScanSnapshot()
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
