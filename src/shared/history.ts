import type { CompletedScanMetadata, ScanEntriesReference } from './scan'
import type { SnapshotAccessErrorCode } from './snapshot'

export const DEFAULT_SCAN_HISTORY_PAGE_SIZE = 20
export const MAX_SCAN_HISTORY_PAGE_SIZE = 100
export const DEFAULT_SCAN_HISTORY_LIMIT = 10

export interface ScanHistoryItem extends CompletedScanMetadata {
  /** Elapsed wall-clock milliseconds derived from startedAt and finishedAt. */
  readonly durationMs: number
  /** Whether this scan is Latest across all retained snapshots. */
  readonly isLatest: boolean
  /** True when recoverable scan errors may have left known totals partial. */
  readonly incomplete: boolean
}

export type ScanHistorySort = 'newest' | 'oldest' | 'size-asc' | 'size-desc'

export interface ScanHistoryQuery {
  /** Zero-based offset into the ordered, filtered results. Defaults to zero. */
  readonly offset?: number
  /** Defaults to DEFAULT_SCAN_HISTORY_PAGE_SIZE, up to MAX_SCAN_HISTORY_PAGE_SIZE. */
  readonly limit?: number
  /** Defaults to newest publication first. Size ties use newest publication first. */
  readonly sort?: ScanHistorySort
  /** Exact, case-sensitive match against the stored root path. */
  readonly rootPath?: string
  /** Literal, case-sensitive substring. Combined with rootPath when both are present. */
  readonly rootPathContains?: string
}

export type ResolvedScanHistoryQuery = ScanHistoryQuery &
  Required<Pick<ScanHistoryQuery, 'offset' | 'limit' | 'sort'>>

export type ScanHistoryMetadataRequest = Pick<ScanEntriesReference, 'scanId'>

/** Pagination reflects the retained history at the time of each read. */
export interface ScanHistoryPage {
  readonly items: readonly ScanHistoryItem[]
  readonly offset: number
  readonly limit: number
  readonly totalCount: number
  readonly nextOffset: number | null
  /** Latest across all retained scans, including when it is outside this filter or page. */
  readonly latestCompletedScanId: string | null
}

export interface ScanHistoryRetentionSettings {
  /** Positive safe integer. Protected snapshots can temporarily put history over this limit. */
  readonly maxCompletedSnapshots: number
}

export type SnapshotDeletionRequest = Pick<ScanEntriesReference, 'scanId'>

export interface SnapshotDeletionResult extends SnapshotDeletionRequest {
  /** Latest completed scan immediately after deletion, or null if history is empty. */
  readonly latestCompletedScanId: string | null
}

export type ScanHistoryErrorCode =
  | Extract<
      SnapshotAccessErrorCode,
      'INVALID_REQUEST' | 'SNAPSHOT_UNAVAILABLE' | 'SNAPSHOT_EXPIRED'
    >
  | 'SNAPSHOT_IN_USE'
  | 'UNAUTHORIZED'
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR'

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: object | null = Object.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isHistoryPathText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 32767 && !value.includes('\0')
  )
}

/** Resolve omitted fields. Null denotes an invalid request. */
export function resolveScanHistoryQuery(value: unknown): ResolvedScanHistoryQuery | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['offset', 'limit', 'sort', 'rootPath', 'rootPathContains'].includes(key)
    )
  )
    return null

  const offset = Object.hasOwn(value, 'offset') ? value.offset : 0
  const limit = Object.hasOwn(value, 'limit') ? value.limit : DEFAULT_SCAN_HISTORY_PAGE_SIZE
  const sort = Object.hasOwn(value, 'sort') ? value.sort : 'newest'
  if (!isSafeIntegerAtLeast(offset, 0) || !isSafeIntegerAtLeast(limit, 1)) return null
  if (limit > MAX_SCAN_HISTORY_PAGE_SIZE) return null
  if (sort !== 'newest' && sort !== 'oldest' && sort !== 'size-asc' && sort !== 'size-desc')
    return null

  const query: ResolvedScanHistoryQuery = { offset, limit, sort }
  for (const field of ['rootPath', 'rootPathContains'] as const) {
    if (!Object.hasOwn(value, field)) continue
    const path = value[field]
    if (!isHistoryPathText(path)) return null
    Object.assign(query, { [field]: path })
  }
  return query
}

export function isScanHistoryRetentionSettings(
  value: unknown
): value is ScanHistoryRetentionSettings {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'maxCompletedSnapshots') &&
    isSafeIntegerAtLeast(value.maxCompletedSnapshots, 1)
  )
}
