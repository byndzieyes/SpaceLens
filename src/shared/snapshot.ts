import type { FileEntry, ScanEntriesReference, ScanSummary } from './scan'

/** Immutable, temporary data. A reference expires when a newer snapshot replaces it. */
export interface ScanSnapshot {
  readonly entries: ScanEntriesReference
  readonly root: FileEntry
  readonly completedAt: string
  readonly summary: ScanSummary
  readonly entryCount: number
  /** Known bytes may be partial even though all emitted entries were retained. */
  readonly incomplete: boolean
}

export interface ScanSnapshotAvailability {
  readonly snapshot: ScanSnapshot | null
  /** Latest completed scan whose entries could not be retained; an older snapshot may remain. */
  readonly unavailable: {
    readonly scanId: string
    readonly reason: 'limit-exceeded' | 'invalid-data'
  } | null
}

export interface ScanEntryRequest {
  readonly scanId: string
  readonly entryId: string
}

export interface ScanDirectoryRequest extends ScanEntryRequest {
  /** Zero-based offset into immutable children ordered by name, then ID (UTF-16 order). */
  readonly offset: number
  /** Between 1 and MAX_SCAN_DIRECTORY_PAGE_SIZE, inclusive. */
  readonly limit: number
}

export const MAX_SCAN_DIRECTORY_PAGE_SIZE = 100

export interface ScanDirectoryPage {
  readonly scanId: string
  readonly directoryId: string
  readonly entries: readonly FileEntry[]
  readonly totalCount: number
  readonly nextOffset: number | null
}

export type SnapshotAccessErrorCode =
  | 'INVALID_REQUEST'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'SNAPSHOT_EXPIRED'
  | 'ENTRY_NOT_FOUND'
  | 'NOT_DIRECTORY'
