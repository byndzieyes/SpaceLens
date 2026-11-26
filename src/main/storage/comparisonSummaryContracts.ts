import type {
  ComparisonFileSummary,
  ComparisonPair,
  ComparisonSummary
} from '../../shared/comparison'
import type { CompletedScanMetadata } from '../../shared/scan'
import { isCompatiblePair } from './comparisonMatchContracts'
import { integer, isSnapshotId, isStorageScan, record } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'

export function readComparisonPair(value: unknown): ComparisonPair {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'baselineScanId') ||
    !Object.hasOwn(value, 'targetScanId') ||
    !isSnapshotId(value.baselineScanId) ||
    !isSnapshotId(value.targetScanId)
  )
    throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid comparison pair.')
  return { baselineScanId: value.baselineScanId, targetScanId: value.targetScanId }
}

function isCompletedMetadata(value: unknown, id: string): value is CompletedScanMetadata {
  return (
    isStorageScan(value) &&
    value.status === 'completed' &&
    value.id === id &&
    value.summary.directoryCount >= 1
  )
}

function signed(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export function isComparisonSummary(value: unknown): value is ComparisonSummary {
  if (!record(value) || !isCompatiblePair(value.compatibility) || !record(value.pair)) return false
  const { pair, coverage } = value.compatibility
  const { baseline, target, observedSnapshotBytes: observed, files } = value
  if (
    value.pair.baselineScanId !== pair.baselineScanId ||
    value.pair.targetScanId !== pair.targetScanId ||
    !isCompletedMetadata(baseline, pair.baselineScanId) ||
    !isCompletedMetadata(target, pair.targetScanId) ||
    !record(observed) ||
    !isComparisonFileSummary(files)
  )
    return false

  const before = baseline.summary
  const after = target.summary
  if (
    coverage.baseline !== (before.errorCount ? 'incomplete' : 'complete') ||
    coverage.target !== (after.errorCount ? 'incomplete' : 'complete') ||
    observed.baseline !== before.totalBytes ||
    observed.target !== after.totalBytes ||
    observed.delta !== after.totalBytes - before.totalBytes ||
    value.fileCountDelta !== after.fileCount - before.fileCount ||
    value.directoryCountDelta !== after.directoryCount - before.directoryCount ||
    files.positiveDeltaBytes > after.totalBytes ||
    files.negativeDeltaBytes < -before.totalBytes
  )
    return false

  return (
    coverage.baseline !== 'complete' ||
    coverage.target !== 'complete' ||
    files.unknownDeltaCount !== 0 ||
    files.netKnownDeltaBytes === observed.delta
  )
}

export function isComparisonFileSummary(files: unknown): files is ComparisonFileSummary {
  if (!record(files) || !record(files.counts)) return false
  const {
    counts,
    totalCount,
    knownDeltaCount,
    unknownDeltaCount,
    positiveDeltaBytes,
    negativeDeltaBytes,
    netKnownDeltaBytes,
    confirmedKnownDeltaBytes,
    confirmedUnknownDeltaCount
  } = files
  const { added, removed, modified, unchanged, indeterminate } = counts
  if (
    !integer(added) ||
    !integer(removed) ||
    !integer(modified) ||
    !integer(unchanged) ||
    !integer(indeterminate) ||
    !integer(totalCount) ||
    !integer(knownDeltaCount) ||
    !integer(unknownDeltaCount) ||
    !integer(positiveDeltaBytes) ||
    !signed(negativeDeltaBytes) ||
    !signed(netKnownDeltaBytes) ||
    !signed(confirmedKnownDeltaBytes) ||
    !integer(confirmedUnknownDeltaCount)
  )
    return false
  const uncertainUnknownCount = unknownDeltaCount - confirmedUnknownDeltaCount
  return (
    BigInt(totalCount) ===
      BigInt(added) +
        BigInt(removed) +
        BigInt(modified) +
        BigInt(unchanged) +
        BigInt(indeterminate) &&
    totalCount - knownDeltaCount === unknownDeltaCount &&
    negativeDeltaBytes <= 0 &&
    netKnownDeltaBytes === positiveDeltaBytes + negativeDeltaBytes &&
    (knownDeltaCount !== 0 || (positiveDeltaBytes === 0 && negativeDeltaBytes === 0)) &&
    unchanged <= knownDeltaCount &&
    confirmedKnownDeltaBytes >= negativeDeltaBytes &&
    confirmedKnownDeltaBytes <= positiveDeltaBytes &&
    (indeterminate !== 0 || confirmedKnownDeltaBytes === netKnownDeltaBytes) &&
    uncertainUnknownCount >= 0 &&
    uncertainUnknownCount <= indeterminate
  )
}
