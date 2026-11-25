import type { FileEntry, ScanEntriesReference, ScanSummary } from './scan'

/** Immutable metadata for one completed snapshot. */
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
  /** @deprecated SQLite publications always send null. */
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

export const MAX_SCAN_TREEMAP_ENTRIES = 100

export interface ScanDirectoryTreemapRequest extends ScanEntryRequest {
  /** Defaults to MAX_SCAN_TREEMAP_ENTRIES; accepts integers from 1 through that limit. */
  readonly limit?: number
}

export interface ScanTreemapOther {
  readonly count: number
  readonly knownBytes: number
  readonly unknownCount: number
  readonly zeroCount: number
}

export interface ScanDirectoryTreemap {
  readonly scanId: string
  readonly directoryId: string
  /** Descending known size, then snapshot name/ID order. Unknown sizes rank after known zero. */
  readonly entries: readonly FileEntry[]
  readonly totalCount: number
  readonly individualCount: number
  readonly unknownCount: number
  readonly other: ScanTreemapOther | null
}

export function knownTreemapBytes(entry: FileEntry): number | null {
  const bytes =
    entry.type === 'file'
      ? entry.sizeBytes
      : entry.type === 'directory'
        ? entry.aggregatedSizeBytes
        : null
  return bytes !== null && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

export type SnapshotAccessErrorCode =
  | 'INVALID_REQUEST'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'SNAPSHOT_EXPIRED'
  | 'ENTRY_NOT_FOUND'
  | 'NOT_DIRECTORY'
  | 'SIZE_OVERFLOW'
