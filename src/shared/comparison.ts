import type { ScanHistoryErrorCode } from './history'
import type { CompletedScanMetadata, FileEntry, ScanSession, ScanSummary } from './scan'
import type { ScanEntryRequest, SnapshotAccessErrorCode } from './snapshot'

/** Ordered IDs of two distinct retained publications. Latest is irrelevant. */
export interface ComparisonPair {
  readonly baselineScanId: string
  readonly targetScanId: string
}

export type ComparisonSide = 'baseline' | 'target'
export type ComparisonPathStyle = 'posix' | 'win32'
export type ComparisonCoverage = 'complete' | 'incomplete' | 'unknown'

export interface ComparisonScanSemantics {
  readonly pathStyle: ComparisonPathStyle
  /** Identity of the established traversal, scope, and metadata policy. */
  readonly traversalPolicy: string
}

/** Evidence supplied by trusted storage. The policy is derived for known producers. */
export interface ComparisonSnapshotMetadata extends Pick<
  ScanSession,
  'id' | 'rootPath' | 'status'
> {
  readonly summary: Partial<Pick<ScanSummary, 'errorCount'>>
  readonly semantics?: ComparisonScanSemantics
}

export type ComparisonWarning =
  | { readonly code: 'INCOMPLETE_COVERAGE'; readonly side: ComparisonSide }
  | {
      readonly code: 'INSUFFICIENT_COMPATIBILITY_METADATA'
      readonly field: 'coverage'
      readonly side: ComparisonSide
    }

export type ComparisonIncompatibility =
  | { readonly code: 'SAME_SNAPSHOT' | 'DIFFERENT_ROOTS' | 'INCOMPATIBLE_SCAN_SEMANTICS' }
  | {
      readonly code: 'SNAPSHOT_EXPIRED' | 'SNAPSHOT_UNAVAILABLE'
      readonly side: ComparisonSide
    }
  | {
      readonly code: 'INSUFFICIENT_COMPATIBILITY_METADATA'
      readonly field: 'scan-semantics' | 'root-path'
      readonly side: ComparisonSide
    }

interface CompatibleComparison {
  readonly pathStyle: ComparisonPathStyle
  readonly normalizedRoot: string
  readonly coverage: Readonly<Record<ComparisonSide, ComparisonCoverage>>
}

/** Metadata compatibility grants no authorization and does not validate either tree. */
export type ComparisonCompatibility = { readonly pair: ComparisonPair } & (
  | ({ readonly status: 'compatible' } & CompatibleComparison)
  | ({
      readonly status: 'compatible-with-warnings'
      readonly warnings: readonly [ComparisonWarning, ...ComparisonWarning[]]
    } & CompatibleComparison)
  | { readonly status: 'incompatible'; readonly reason: ComparisonIncompatibility }
)

export type CompatiblePair = Exclude<ComparisonCompatibility, { status: 'incompatible' }>

export interface ComparisonPreparationTicket {
  readonly ticket: string
}

export interface PreparedComparisonSelection extends ComparisonPreparationTicket {
  readonly compatibility: CompatiblePair
}

export interface AdoptedComparisonSelection {
  /** A new identity is issued for every adoption, including readoption of the same pair. */
  readonly selectionId: string
  readonly compatibility: CompatiblePair
}

export interface ComparisonSelectionRelease {
  /** Use null to leave Comparison while the initial pair is still pending. */
  readonly selectionId: string | null
}

export interface ComparisonReadRequest<Query extends ComparisonPair = ComparisonPair> {
  readonly selectionId: string
  readonly query: Query
}

/** Empty for the root only. Descendants use slash-delimited, exact UTF-16 components. */
export type ComparisonPathKey = string

export type EntryChangeKind = 'added' | 'removed' | 'modified' | 'unchanged' | 'indeterminate'

/** An exact saved entry reference for snapshot-specific Explorer navigation. */
export type ComparisonEntryReference = ScanEntryRequest & Pick<FileEntry, 'type'>

export type ComparisonPathObservation =
  | {
      readonly presence: 'present'
      readonly entry: ComparisonEntryReference & Pick<FileEntry, 'sizeBytes' | 'modifiedAt'>
    }
  | { readonly presence: 'absent' }
  | { readonly presence: 'unknown' }

export type FileChangeClassification =
  | {
      readonly kind: 'added' | 'removed'
      readonly reason: 'confirmed-absence' | 'type-replacement'
    }
  | {
      readonly kind: 'modified'
      readonly reason: 'size-changed' | 'modified-time-changed' | 'size-and-modified-time-changed'
    }
  | { readonly kind: 'unchanged'; readonly reason: 'metadata-equal' }
  | {
      readonly kind: 'indeterminate'
      readonly reason: 'unknown-presence' | 'unknown-entry-type' | 'unknown-metadata'
    }

/** Non-negative safe integer logical bytes. Null indicates unknown. */
export type ComparisonLogicalBytes = number | null

/** Signed safe integer Target minus Baseline. Null means the delta cannot be established. */
export type ComparisonByteDelta = number | null

export type ComparisonFileChange = FileChangeClassification & {
  readonly relativePath: ComparisonPathKey
  readonly baseline: ComparisonPathObservation
  readonly target: ComparisonPathObservation
  readonly deltaBytes: ComparisonByteDelta
}

export interface ComparisonFileTotals {
  /** Exactly one count per path with a known regular file on either side. */
  readonly counts: Readonly<Record<EntryChangeKind, number>>
  /** Sum of known deltas from confirmed changes, excluding indeterminate classifications. */
  readonly confirmedKnownDeltaBytes: number
  /** Confirmed changes with an unknown byte contribution. */
  readonly confirmedUnknownDeltaCount: number
}

export interface ComparisonFileSummary extends ComparisonFileTotals {
  readonly totalCount: number
  /** Includes known zero deltas and known deltas on indeterminate rows. */
  readonly knownDeltaCount: number
  readonly unknownDeltaCount: number
  readonly positiveDeltaBytes: number
  /** Sum of negative deltas, kept signed. */
  readonly negativeDeltaBytes: number
  readonly netKnownDeltaBytes: number
}

export interface ComparisonSummary {
  readonly pair: ComparisonPair
  readonly compatibility: CompatiblePair
  readonly baseline: CompletedScanMetadata
  readonly target: CompletedScanMetadata
  readonly fileCountDelta: number
  /** Includes the root in each snapshot count. */
  readonly directoryCountDelta: number
  /** Snapshot accounting only. With incomplete coverage this can differ from actual growth. */
  readonly observedSnapshotBytes: {
    readonly baseline: number
    readonly target: number
    readonly delta: number
  }
  readonly files: ComparisonFileSummary
}

export type ComparisonDirectoryObservation =
  | {
      readonly presence: 'present'
      readonly entry: ComparisonEntryReference & { readonly type: 'directory' }
      /** Retained subtree aggregate of known bytes, which may be partial. */
      readonly observedBytes: ComparisonLogicalBytes
    }
  | { readonly presence: 'absent' }
  | { readonly presence: 'unknown' }

export interface ComparisonDirectoryChange {
  readonly relativePath: ComparisonPathKey
  readonly kind: EntryChangeKind
  readonly baseline: ComparisonDirectoryObservation
  readonly target: ComparisonDirectoryObservation
  readonly observedDeltaBytes: ComparisonByteDelta
  /** Known non-directory at this exact path on the opposite side. */
  readonly typeReplacement: boolean
  /** Coverage, classification, or byte accounting is incomplete. */
  readonly uncertain: boolean
  /** Each descendant file path contributes once. Rows for nested directories overlap. */
  readonly subtreeFiles: ComparisonFileSummary
}

export const DEFAULT_COMPARISON_PAGE_SIZE = 20
export const MAX_COMPARISON_PAGE_SIZE = 100

/** Delta sorts put unknowns last. All ties use ascending UTF-16 path order. */
export type ComparisonSort = 'path' | 'delta-asc' | 'delta-desc'

interface ComparisonPageQuery extends ComparisonPair {
  /** Defaults to zero. */
  readonly offset?: number
  /** Defaults to 20, up to 100 records. */
  readonly limit?: number
  /** Defaults to ascending UTF-16 path order. */
  readonly sort?: ComparisonSort
  /** Includes the selected directory and its descendants. Empty selects the root. */
  readonly relativeDirectory?: ComparisonPathKey
  /** Include any of the selected kinds. Omit to include all. */
  readonly kinds?: readonly EntryChangeKind[]
}

export type ComparisonFileQuery = ComparisonPageQuery
export type ComparisonDirectoryQuery = ComparisonPageQuery & {
  /** Include the root in an unscoped query. Defaults to false. */
  readonly includeRoot?: boolean
}

interface ComparisonPage<Item> {
  readonly pair: ComparisonPair
  readonly items: readonly Item[]
  readonly offset: number
  readonly limit: number
  readonly totalCount: number
  readonly nextOffset: number | null
}

export type ComparisonFilePage = ComparisonPage<ComparisonFileChange>
export type ComparisonDirectoryPage = ComparisonPage<ComparisonDirectoryChange>
export type ComparisonFileResult = ComparisonFilePage & { readonly compatibility: CompatiblePair }
export type ComparisonDirectoryResult = ComparisonDirectoryPage & {
  readonly compatibility: CompatiblePair
}

export type ComparisonErrorCode =
  | Extract<
      ScanHistoryErrorCode,
      'UNAUTHORIZED' | 'UNAVAILABLE' | 'INTERNAL_ERROR' | 'SNAPSHOT_IN_USE'
    >
  | Extract<
      SnapshotAccessErrorCode,
      'INVALID_REQUEST' | 'SNAPSHOT_EXPIRED' | 'SNAPSHOT_UNAVAILABLE' | 'SIZE_OVERFLOW'
    >
  | 'INCOMPATIBLE_SNAPSHOTS'
  | 'INVALID_COMPARISON_PATH'
  | 'AMBIGUOUS_COMPARISON_PATH'
