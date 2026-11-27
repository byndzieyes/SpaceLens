import type {
  ComparisonCompatibility,
  ComparisonCoverage,
  ComparisonIncompatibility,
  ComparisonPair,
  ComparisonScanSemantics,
  ComparisonSnapshotMetadata,
  ComparisonWarning
} from '../../shared/comparison'
import { normalizeComparisonRoot } from './paths'
import type { TrendSeries } from '../../shared/trends'

const storedTraversalPolicy = 'spacelens-v1-v2'

function storedScanSemantics(rootPath: string): ComparisonScanSemantics | undefined {
  if (/^[a-z]:[\\/]/i.test(rootPath) || rootPath.startsWith('\\\\'))
    return { pathStyle: 'win32', traversalPolicy: storedTraversalPolicy }
  if (rootPath.startsWith('/') && !rootPath.startsWith('//'))
    return { pathStyle: 'posix', traversalPolicy: storedTraversalPolicy }
  return undefined
}

export function comparisonSeries(
  rootPath: string,
  semantics = storedScanSemantics(rootPath)
): TrendSeries | null {
  if (semantics?.traversalPolicy !== storedTraversalPolicy) return null
  const normalizedRoot = normalizeComparisonRoot(rootPath, semantics.pathStyle)
  return normalizedRoot === null ? null : { normalizedRoot, ...semantics }
}

/**
 * Use only for official v1/v2 scan rows, including migrated publications. The
 * scanner persisted native resolved paths under one fixed traversal policy.
 * A double-slash path is ambiguous without independently known path semantics.
 */
export function comparisonMetadataForStoredScan(
  scan: Omit<ComparisonSnapshotMetadata, 'semantics'>
): ComparisonSnapshotMetadata {
  const { rootPath, id, status, summary } = scan
  const metadata = { id, status, rootPath, summary }
  const semantics = storedScanSemantics(rootPath)
  return semantics ? { ...metadata, semantics } : metadata
}

function readCoverage({ summary }: ComparisonSnapshotMetadata): ComparisonCoverage {
  const { errorCount } = summary
  if (errorCount === undefined || !Number.isSafeInteger(errorCount) || errorCount < 0)
    return 'unknown'
  return errorCount === 0 ? 'complete' : 'incomplete'
}

/** Compare trusted scan metadata resolved by exact ID, without accessing any live paths. */
export function evaluateComparisonCompatibility(
  pair: ComparisonPair,
  baseline: ComparisonSnapshotMetadata | null,
  target: ComparisonSnapshotMetadata | null
): ComparisonCompatibility {
  const incompatible = (reason: ComparisonIncompatibility): ComparisonCompatibility => ({
    pair,
    status: 'incompatible',
    reason
  })
  if (pair.baselineScanId === pair.targetScanId) return incompatible({ code: 'SAME_SNAPSHOT' })
  if (baseline?.id !== pair.baselineScanId)
    return incompatible({ code: 'SNAPSHOT_EXPIRED', side: 'baseline' })
  if (target?.id !== pair.targetScanId)
    return incompatible({ code: 'SNAPSHOT_EXPIRED', side: 'target' })
  if (baseline.status !== 'completed')
    return incompatible({ code: 'SNAPSHOT_UNAVAILABLE', side: 'baseline' })
  if (target.status !== 'completed')
    return incompatible({ code: 'SNAPSHOT_UNAVAILABLE', side: 'target' })

  const baselineSemantics = baseline.semantics
  const targetSemantics = target.semantics
  if (
    baselineSemantics &&
    targetSemantics &&
    (baselineSemantics.traversalPolicy !== targetSemantics.traversalPolicy ||
      baselineSemantics.pathStyle !== targetSemantics.pathStyle)
  ) {
    return incompatible({ code: 'INCOMPATIBLE_SCAN_SEMANTICS' })
  }
  if (baselineSemantics?.traversalPolicy !== storedTraversalPolicy) {
    return incompatible({
      code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
      field: 'scan-semantics',
      side: 'baseline'
    })
  }
  if (targetSemantics?.traversalPolicy !== storedTraversalPolicy) {
    return incompatible({
      code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
      field: 'scan-semantics',
      side: 'target'
    })
  }

  const { pathStyle } = baselineSemantics
  const baselineRoot = comparisonSeries(baseline.rootPath, baselineSemantics)?.normalizedRoot
  const targetRoot = comparisonSeries(target.rootPath, targetSemantics)?.normalizedRoot
  if (baselineRoot === undefined)
    return incompatible({
      code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
      field: 'root-path',
      side: 'baseline'
    })
  if (targetRoot === undefined)
    return incompatible({
      code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
      field: 'root-path',
      side: 'target'
    })
  if (baselineRoot !== targetRoot) return incompatible({ code: 'DIFFERENT_ROOTS' })

  const coverage = { baseline: readCoverage(baseline), target: readCoverage(target) }
  const warnings: ComparisonWarning[] = []
  for (const side of ['baseline', 'target'] as const) {
    if (coverage[side] === 'incomplete') warnings.push({ code: 'INCOMPLETE_COVERAGE', side })
    if (coverage[side] === 'unknown')
      warnings.push({ code: 'INSUFFICIENT_COMPATIBILITY_METADATA', field: 'coverage', side })
  }
  const [first, ...rest] = warnings
  const common = { pair, pathStyle, normalizedRoot: baselineRoot, coverage }
  return first
    ? { ...common, status: 'compatible-with-warnings', warnings: [first, ...rest] }
    : { ...common, status: 'compatible' }
}
