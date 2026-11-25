import type {
  ComparisonCompatibility,
  ComparisonCoverage,
  ComparisonIncompatibility,
  ComparisonPair,
  ComparisonPathStyle,
  ComparisonSnapshotMetadata,
  ComparisonWarning
} from '../../shared/comparison'
import { normalizeComparisonRoot } from './paths'

const storedTraversalPolicy = 'spacelens-v1-v2'

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
  let pathStyle: ComparisonPathStyle
  if (/^[a-z]:[\\/]/i.test(rootPath) || rootPath.startsWith('\\\\')) pathStyle = 'win32'
  else if (rootPath.startsWith('/') && !rootPath.startsWith('//')) pathStyle = 'posix'
  else return metadata
  return { ...metadata, semantics: { pathStyle, traversalPolicy: storedTraversalPolicy } }
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
  const baselineRoot = normalizeComparisonRoot(baseline.rootPath, pathStyle)
  const targetRoot = normalizeComparisonRoot(target.rootPath, pathStyle)
  if (baselineRoot === null)
    return incompatible({
      code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
      field: 'root-path',
      side: 'baseline'
    })
  if (targetRoot === null)
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
