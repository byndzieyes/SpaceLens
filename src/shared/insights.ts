import type { ScanSummary } from './scan'

/** Identifies a specific publication. Replacement does not retarget the request. */
export interface InsightsRequest {
  readonly scanId: string
}

export interface InsightsSummary {
  readonly scanId: string
  readonly rootPath: string
  /** ISO 8601 timestamp from the publication, preserving its timezone offset. */
  readonly completedAt: string
  /** Stored counts and known logical bytes. Zero is a recorded value. */
  readonly summary: ScanSummary
  /** Known totals may be partial because the scan recorded filesystem errors. */
  readonly incomplete: boolean
}
