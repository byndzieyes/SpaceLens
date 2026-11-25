import type {
  ComparisonByteDelta,
  ComparisonCoverage,
  ComparisonFileChange,
  ComparisonLogicalBytes,
  ComparisonPathKey,
  ComparisonPathObservation,
  FileChangeClassification
} from '../../shared/comparison'

type ObservedEntry = Extract<ComparisonPathObservation, { presence: 'present' }>['entry']

/** A missing row establishes absence only on a side with adequate scan coverage. */
export function observeComparisonPath(
  entry: ObservedEntry | null,
  coverage: ComparisonCoverage
): ComparisonPathObservation {
  if (entry) return { presence: 'present', entry }
  return coverage === 'complete' ? { presence: 'absent' } : { presence: 'unknown' }
}

/** Only proven absence of a regular file contributes zero for a missing file side. */
function logicalFileBytes(observation: ComparisonPathObservation): ComparisonLogicalBytes {
  if (observation.presence === 'absent') return 0
  if (observation.presence === 'unknown') return null
  const { type, sizeBytes } = observation.entry
  if (type === 'file') return sizeBytes
  return type === 'unknown' ? null : 0
}

export function logicalByteDelta(
  baseline: ComparisonLogicalBytes,
  target: ComparisonLogicalBytes
): ComparisonByteDelta {
  for (const bytes of [baseline, target]) {
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
      throw new RangeError('Logical bytes must be non-negative safe integers.')
  }
  // Subtracting two non-negative safe integers stays in the signed safe range.
  if (baseline === null || target === null) return null
  return baseline === target ? 0 : target - baseline
}

function modificationTime(value: string | null): number | null {
  if (value === null) return null
  const milliseconds = Date.parse(value)
  // Both scanner versions store Date.toISOString() output at millisecond precision.
  // Unusable or noncanonical stored metadata provides no evidence of a change.
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null
}

function classifyMatchedFiles(
  baseline: ObservedEntry,
  target: ObservedEntry
): FileChangeClassification {
  const baselineTime = modificationTime(baseline.modifiedAt)
  const targetTime = modificationTime(target.modifiedAt)
  const sizesKnown = baseline.sizeBytes !== null && target.sizeBytes !== null
  const timesKnown = baselineTime !== null && targetTime !== null
  const sizeChanged = sizesKnown && baseline.sizeBytes !== target.sizeBytes
  const timeChanged = timesKnown && baselineTime !== targetTime
  if (sizeChanged && timeChanged)
    return { kind: 'modified', reason: 'size-and-modified-time-changed' }
  if (sizeChanged) return { kind: 'modified', reason: 'size-changed' }
  if (timeChanged) return { kind: 'modified', reason: 'modified-time-changed' }
  if (sizesKnown && timesKnown) return { kind: 'unchanged', reason: 'metadata-equal' }
  return { kind: 'indeterminate', reason: 'unknown-metadata' }
}

function classifyUnmatchedFile(
  other: ComparisonPathObservation,
  kind: 'added' | 'removed'
): FileChangeClassification {
  if (other.presence === 'unknown') return { kind: 'indeterminate', reason: 'unknown-presence' }
  if (other.presence === 'absent') return { kind, reason: 'confirmed-absence' }
  if (other.entry.type === 'unknown') return { kind: 'indeterminate', reason: 'unknown-entry-type' }
  return { kind, reason: 'type-replacement' }
}

/** Reference policy for one validated canonical key. No row if neither side is a known file. */
export function classifyFileChange(
  relativePath: ComparisonPathKey,
  baseline: ComparisonPathObservation,
  target: ComparisonPathObservation
): ComparisonFileChange | null {
  if (relativePath === '') return null
  const from =
    baseline.presence === 'present' && baseline.entry.type === 'file' ? baseline.entry : null
  const to = target.presence === 'present' && target.entry.type === 'file' ? target.entry : null
  if (!from && !to) return null

  const deltaBytes = logicalByteDelta(logicalFileBytes(baseline), logicalFileBytes(target))
  const classification =
    from && to
      ? classifyMatchedFiles(from, to)
      : from
        ? classifyUnmatchedFile(target, 'removed')
        : classifyUnmatchedFile(baseline, 'added')
  return { relativePath, baseline, target, deltaBytes, ...classification }
}
