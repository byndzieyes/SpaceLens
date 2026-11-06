/**
 * Scanner contracts contain only serializable data, with no platform dependencies.
 * Byte sizes and counts are non-negative safe integers; timestamps are ISO 8601
 * strings with a timezone offset or Z. Null means unavailable or not applicable.
 */
export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other' | 'unknown'

/** A flat snapshot entry; relationships are scoped to its scan, not nested objects. */
export interface FileEntry {
  readonly id: string
  readonly scanId: string
  /** Null only for the scan root. */
  readonly parentId: string | null
  /** Absolute filesystem path, preserved without display formatting. */
  readonly path: string
  readonly name: string
  /** Unknown when the entry cannot be classified, for example after a stat error. */
  readonly type: FileEntryType
  /** Logical size of a regular file only; never allocated disk space. */
  readonly sizeBytes: number | null
  /**
   * Sum of known descendant regular-file sizes for a directory only.
   * Null until aggregation is available; zero is a known empty total.
   * Totals may be partial after errors or cancellation; consult the scan result.
   */
  readonly aggregatedSizeBytes: number | null
  readonly createdAt: string | null
  readonly modifiedAt: string | null
}

export type ScanOutcome = 'completed' | 'cancelled' | 'failed'
export type ScanStatus = 'running' | ScanOutcome

/** Observed statistics, which may be partial for unsuccessful scans or after errors. */
export interface ScanSummary {
  readonly fileCount: number
  /** Includes the root directory when it has been identified. */
  readonly directoryCount: number
  /** Sum of known regular-file logical sizes, counted per entry, not unique inode. */
  readonly totalBytes: number
  /** Total recorded errors, including recoverable errors in completed scans. */
  readonly errorCount: number
}

interface ScanSessionDetails {
  /** Unique identifier for one scan attempt and its collected entries. */
  readonly id: string
  readonly rootPath: string
  readonly startedAt: string
  readonly summary: ScanSummary
}

/** Completed means traversal finished, not that every entry was accessible. */
export type ScanSession = ScanSessionDetails &
  (
    | { readonly status: 'running'; readonly finishedAt: null }
    | { readonly status: ScanOutcome; readonly finishedAt: string }
  )

/** Cumulative observations; the total amount of work is not known in advance. */
export interface ScanProgress {
  readonly scanId: string
  readonly processedFileCount: number
  /** Includes the root directory when it has been identified. */
  readonly processedDirectoryCount: number
  /** Known logical bytes accounted for so far, not bytes read from disk. */
  readonly processedBytes: number
  readonly currentPath: string | null
}

/** Plain error data, never a platform-specific Error object. */
export interface ScanError {
  readonly path: string
  /** Filesystem or application error code; null if no code is available. */
  readonly code: string | null
  readonly message: string
}

/**
 * Reference to entries retained outside the renderer. Future directory queries
 * can use scanId and a parent entry ID to retrieve bounded pages of children.
 * This reference does not imply that entries have been persisted to disk.
 */
export interface ScanEntriesReference {
  readonly scanId: string
  /** Null if the scan could not record its root entry. */
  readonly rootEntryId: string | null
}

/** Terminal outcome; partial entries may remain available after cancellation/failure. */
export interface ScanResult {
  readonly session: Extract<ScanSession, { readonly status: ScanOutcome }>
  readonly errors: readonly ScanError[]
  /** Must reference the same scan as session.id; contains no inline snapshot. */
  readonly entries: ScanEntriesReference
}

/** Summary of a completed scan; cancelled and incomplete scans are not included. */
export interface RecentScanSummary {
  readonly id: string
  readonly path: string
  /** ISO 8601 completion timestamp with a timezone offset or Z. */
  readonly completedAt: string
  readonly totalBytes: number
  readonly fileCount: number
}
