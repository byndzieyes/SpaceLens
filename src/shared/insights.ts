import type { FileEntry, ScanSummary } from './scan'

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

export const INSIGHTS_FILE_CATEGORIES = [
  'images',
  'videos',
  'audio',
  'documents',
  'archives',
  'code',
  'applications',
  'other'
] as const

export type InsightsFileCategory = (typeof INSIGHTS_FILE_CATEGORIES)[number]

export interface InsightsFileTotals {
  readonly fileCount: number
  /** Sum of known logical file sizes, in bytes. */
  readonly knownBytes: number
  /** Included in fileCount, independently of known zero-byte files. */
  readonly unknownSizeCount: number
}

export interface InsightsCategoryRow extends InsightsFileTotals {
  readonly category: InsightsFileCategory
}

export interface InsightsFileBreakdown {
  readonly scanId: string
  /** Includes filesystem errors that may not correspond to a counted file. */
  readonly incomplete: boolean
  /** Scan-wide regular-file totals, including groups outside the current page. */
  readonly totals: InsightsFileTotals
}

export interface InsightsCategories extends InsightsFileBreakdown {
  readonly categories: readonly InsightsCategoryRow[]
}

export const DEFAULT_INSIGHTS_EXTENSION_PAGE_SIZE = 50
export const MAX_INSIGHTS_EXTENSION_PAGE_SIZE = 100

export interface InsightsExtensionRequest extends InsightsRequest {
  /** Defaults to zero. */
  readonly offset?: number
  /** Defaults to 50, up to 100 groups per page. */
  readonly limit?: number
}

export interface InsightsExtensionRow extends InsightsCategoryRow {
  /** Lowercase suffix without the dot. Null means the filename has no extension. */
  readonly extension: string | null
}

export interface InsightsExtensionPage extends InsightsFileBreakdown {
  readonly extensions: readonly InsightsExtensionRow[]
  readonly totalCount: number
  readonly nextOffset: number | null
}

export const INSIGHTS_RANKING_LIMIT = 20
export const DEFAULT_INSIGHTS_RANKING_PAGE_SIZE = 10

export interface InsightsRankingRequest extends InsightsRequest {
  /** Defaults to zero. Offsets past the ranking return an empty page. */
  readonly offset?: number
  /** Defaults to 10, up to 20 ranked entries per page. */
  readonly limit?: number
}

export interface InsightsRankedEntry extends Pick<FileEntry, 'scanId' | 'id' | 'name' | 'path'> {
  readonly parentId: string
  readonly type: 'file' | 'directory'
  /** Stored logical size or directory aggregate. Directory totals can overlap. */
  readonly bytes: number | null
}

export interface InsightsRankingPage {
  readonly scanId: string
  readonly incomplete: boolean
  readonly entries: readonly InsightsRankedEntry[]
  readonly offset: number
  readonly limit: number
  /** Number of eligible entries in the bounded ranking. */
  readonly totalCount: number
  readonly nextOffset: number | null
}

/** Each range starts at minBytes and ends before the next range. The final range is open-ended. */
export const INSIGHTS_SIZE_BUCKETS = [
  { id: 'empty', minBytes: 0 },
  { id: 'tiny', minBytes: 1 },
  { id: 'small', minBytes: 1_048_576 },
  { id: 'medium', minBytes: 10_485_760 },
  { id: 'large', minBytes: 104_857_600 },
  { id: 'veryLarge', minBytes: 1_073_741_824 }
] as const

export type InsightsSizeBucketId = (typeof INSIGHTS_SIZE_BUCKETS)[number]['id']

export interface InsightsSizeBucket extends Pick<InsightsFileTotals, 'fileCount' | 'knownBytes'> {
  readonly id: InsightsSizeBucketId
}

export interface InsightsSizeDistribution extends InsightsFileBreakdown {
  /** All six buckets in range order. Unknown sizes appear only in totals.unknownSizeCount. */
  readonly buckets: readonly InsightsSizeBucket[]
  readonly knownSizeCount: number
}

/** Fixed priority order for observations, shared by the generator and protocol. */
export const INSIGHTS_OBSERVATION_TYPES = [
  'incompleteScan',
  'largeFileConcentration',
  'dominantCategory',
  'directoryConcentration',
  'smallFilesPrevalence'
] as const

export type InsightsObservationType = (typeof INSIGHTS_OBSERVATION_TYPES)[number]

interface ByteShare {
  readonly knownBytes: number
  readonly totalKnownBytes: number
}

interface ObservationEvidence {
  incompleteScan: { readonly errorCount: number; readonly unknownSizeCount: number }
  largeFileConcentration: ByteShare & { readonly fileCount: number }
  dominantCategory: ByteShare & { readonly category: InsightsFileCategory }
  directoryConcentration: ByteShare & { readonly entryId: string }
  smallFilesPrevalence: { readonly smallFileCount: number; readonly knownSizeCount: number }
}

export type InsightsObservation = {
  [Type in InsightsObservationType]: {
    readonly id: Type
    readonly type: Type
    readonly title: string
    readonly message: string
    readonly severity: 'info' | 'warning'
    readonly evidence: ObservationEvidence[Type]
  }
}[InsightsObservationType]

export interface InsightsObservations {
  readonly scanId: string
  readonly incomplete: boolean
  readonly observations: readonly InsightsObservation[]
}
