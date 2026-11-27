import type { ComparisonPathStyle } from './comparison'

export const MAX_TREND_POINTS = 100

/** An identity issued from the same trusted scan metadata as Comparison. */
export interface TrendSeries {
  readonly normalizedRoot: string
  readonly pathStyle: ComparisonPathStyle
  readonly traversalPolicy: string
}

export type TrendSelection =
  | { readonly mode: 'latest' }
  | { readonly mode: 'snapshot'; readonly scanId: string }
  | { readonly mode: 'series'; readonly series: TrendSeries }

export interface TrendPoint {
  readonly id: string
  readonly finishedAt: string
  readonly totalBytes: number
  readonly fileCount: number
  readonly directoryCount: number
  readonly incomplete: boolean
}

export interface StorageTrends {
  readonly series: TrendSeries | null
  readonly latestCompletedScanId: string | null
  readonly retainedCount: number
  /** The newest retained window, returned in ascending publication order. */
  readonly points: readonly TrendPoint[]
}
