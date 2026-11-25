import type { CompletedScanMetadata, ScanEntriesReference } from './scan'
import type { SnapshotAccessErrorCode } from './snapshot'

export const DEFAULT_SCAN_HISTORY_PAGE_SIZE = 20
export const MAX_SCAN_HISTORY_PAGE_SIZE = 100
export const DEFAULT_SCAN_HISTORY_LIMIT = 10

export interface ScanHistoryItem extends CompletedScanMetadata {
  /** True when recoverable scan errors may have left known totals partial. */
  readonly incomplete: boolean
}

export interface ScanHistoryQuery {
  /** Zero-based offset into completed scans ordered newest publication first. Defaults to zero. */
  readonly offset?: number
  /** Defaults to DEFAULT_SCAN_HISTORY_PAGE_SIZE, up to MAX_SCAN_HISTORY_PAGE_SIZE. */
  readonly limit?: number
}

/** Pagination reflects the retained history at the time of each read. */
export interface ScanHistoryPage {
  readonly items: readonly ScanHistoryItem[]
  readonly offset: number
  readonly limit: number
  readonly totalCount: number
  readonly nextOffset: number | null
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

/** Resolve omitted fields. Null denotes an invalid request. */
export function resolveScanHistoryQuery(value: unknown): Required<ScanHistoryQuery> | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'offset' && key !== 'limit'))
    return null

  const offset = Object.hasOwn(value, 'offset') ? value.offset : 0
  const limit = Object.hasOwn(value, 'limit') ? value.limit : DEFAULT_SCAN_HISTORY_PAGE_SIZE
  if (!isSafeIntegerAtLeast(offset, 0) || !isSafeIntegerAtLeast(limit, 1)) return null
  if (limit > MAX_SCAN_HISTORY_PAGE_SIZE) return null
  return { offset, limit }
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
