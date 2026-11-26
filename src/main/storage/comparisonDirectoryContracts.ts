import {
  MAX_COMPARISON_PAGE_SIZE,
  type ComparisonDirectoryObservation,
  type ComparisonDirectoryResult
} from '../../shared/comparison'
import { isComparisonPathKey } from '../comparison/paths'
import {
  isChangeKind,
  readComparisonFileQuery,
  type ResolvedComparisonFileQuery
} from './comparisonFileContracts'
import { isCompatiblePair } from './comparisonMatchContracts'
import { isComparisonFileSummary } from './comparisonSummaryContracts'
import { integer, isSnapshotId, record } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'

export type { ComparisonDirectoryResult } from '../../shared/comparison'
export type ResolvedComparisonDirectoryQuery = ResolvedComparisonFileQuery & {
  readonly includeRoot: boolean
}

function invalidQuery(): SnapshotAccessError {
  return new SnapshotAccessError('INVALID_REQUEST', 'Invalid directory change query.')
}

export function readComparisonDirectoryQuery(value: unknown): ResolvedComparisonDirectoryQuery {
  if (!record(value)) throw invalidQuery()
  const { includeRoot, ...filters } = value
  if (Object.hasOwn(value, 'includeRoot') && typeof includeRoot !== 'boolean') throw invalidQuery()
  return { ...readComparisonFileQuery(filters, invalidQuery), includeRoot: includeRoot === true }
}

function isDirectoryObservation(
  value: unknown,
  scanId: string
): value is ComparisonDirectoryObservation {
  if (!record(value)) return false
  if (value.presence === 'unknown' || value.presence === 'absent')
    return !Object.hasOwn(value, 'entry') && !Object.hasOwn(value, 'observedBytes')
  return (
    value.presence === 'present' &&
    record(value.entry) &&
    value.entry.type === 'directory' &&
    value.entry.scanId === scanId &&
    isSnapshotId(value.entry.entryId) &&
    (value.observedBytes === null || integer(value.observedBytes))
  )
}

function directoryBytes(observation: ComparisonDirectoryObservation): number | null {
  if (observation.presence === 'present') return observation.observedBytes
  return observation.presence === 'absent' ? 0 : null
}

export function isComparisonDirectoryResult(value: unknown): value is ComparisonDirectoryResult {
  if (
    !record(value) ||
    !record(value.pair) ||
    !isCompatiblePair(value.compatibility) ||
    !integer(value.offset) ||
    !integer(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_COMPARISON_PAGE_SIZE ||
    !integer(value.totalCount) ||
    !Array.isArray(value.items)
  )
    return false
  const { pair, pathStyle, coverage } = value.compatibility
  if (
    value.pair.baselineScanId !== pair.baselineScanId ||
    value.pair.targetScanId !== pair.targetScanId
  )
    return false
  const size = Math.min(value.limit, Math.max(0, value.totalCount - value.offset))
  const end = size + value.offset
  if (value.items.length !== size || value.nextOffset !== (end < value.totalCount ? end : null))
    return false
  const paths = new Set<string>()
  for (const item of value.items as unknown[]) {
    if (
      !record(item) ||
      typeof item.relativePath !== 'string' ||
      !isComparisonPathKey(item.relativePath, pathStyle) ||
      paths.has(item.relativePath) ||
      !isChangeKind(item.kind) ||
      !isDirectoryObservation(item.baseline, pair.baselineScanId) ||
      !isDirectoryObservation(item.target, pair.targetScanId) ||
      typeof item.typeReplacement !== 'boolean' ||
      typeof item.uncertain !== 'boolean' ||
      !isComparisonFileSummary(item.subtreeFiles)
    )
      return false
    const { baseline, target, observedDeltaBytes, typeReplacement, uncertain, kind, subtreeFiles } =
      item
    const before = directoryBytes(baseline)
    const after = directoryBytes(target)
    const paired = baseline.presence === 'present' && target.presence === 'present'
    if (
      (item.relativePath === '' && !paired) ||
      (baseline.presence !== 'present' && target.presence !== 'present') ||
      observedDeltaBytes !== (before === null || after === null ? null : after - before) ||
      (typeReplacement && baseline.presence !== 'absent' && target.presence !== 'absent') ||
      (!uncertain &&
        (before === null ||
          after === null ||
          coverage.baseline !== 'complete' ||
          coverage.target !== 'complete' ||
          subtreeFiles.unknownDeltaCount > 0 ||
          subtreeFiles.counts.indeterminate > 0)) ||
      (kind === 'unchanged' && uncertain) ||
      (paired
        ? kind === 'added' || kind === 'removed'
        : kind !==
          (baseline.presence === 'absent'
            ? 'added'
            : target.presence === 'absent'
              ? 'removed'
              : 'indeterminate'))
    )
      return false
    paths.add(item.relativePath)
  }
  return true
}
