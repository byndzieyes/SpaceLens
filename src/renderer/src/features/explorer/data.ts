import type { ScannerIpcResult } from '../../../../shared/ipc'
import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  type ScanDirectoryPage,
  type ScanDirectoryRequest,
  type ScanEntryRequest,
  type ScanSnapshot,
  type ScanSnapshotAvailability
} from '../../../../shared/snapshot'

/** Availability at query time, not a guarantee that a later request will succeed. */
export type ExplorerSnapshotState =
  | {
      readonly status: 'available'
      readonly snapshot: ScanSnapshot
      /** A newer summary-only scan can coexist with this published snapshot. */
      readonly unavailable: ScanSnapshotAvailability['unavailable']
    }
  | {
      readonly status: 'summary-only'
      readonly snapshot: null
      readonly unavailable: NonNullable<ScanSnapshotAvailability['unavailable']>
    }
  | { readonly status: 'missing'; readonly snapshot: null; readonly unavailable: null }

/**
 * Resolve the one published in-memory snapshot without loading its children.
 * Its entries.scanId and root.id identify the explorable root; a completed scan
 * summary alone does not. Summary-only metadata supplies a scan ID and reason,
 * not that scan's summary or root. Data disappears when the application exits.
 *
 * For entry details, use window.spaceLens.getScanEntry({ scanId, entryId })
 * directly: it already returns ScannerIpcResult<FileEntry>. Keep IDs from the
 * same snapshot, and handle SNAPSHOT_EXPIRED without silently switching scans.
 * Structured failures and rejected transport promises are preserved unchanged.
 */
export async function resolveExplorerSnapshot(): Promise<ScannerIpcResult<ExplorerSnapshotState>> {
  const result = await window.spaceLens.getScanSnapshot()
  if (!result.ok) return result
  const { snapshot, unavailable } = result.value
  if (snapshot) return { ok: true, value: { status: 'available', snapshot, unavailable } }
  if (unavailable)
    return { ok: true, value: { status: 'summary-only', snapshot: null, unavailable } }
  return { ok: true, value: { status: 'missing', snapshot: null, unavailable: null } }
}

/**
 * Fetch exactly one page, defaulting to the first 100 direct children.
 * Follow nextOffset explicitly with the same IDs; never treat one page as a
 * complete tree/treemap. Main's UTF-16 name/ID order and page metadata pass
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
