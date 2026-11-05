/** Summary of a completed scan; cancelled and incomplete scans are not included. */
export interface RecentScanSummary {
  readonly id: string
  readonly path: string
  /** ISO 8601 completion timestamp with a timezone offset or Z. */
  readonly completedAt: string
  readonly totalBytes: number
  readonly fileCount: number
}
