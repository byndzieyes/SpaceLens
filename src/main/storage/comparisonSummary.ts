import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ComparisonSummary, EntryChangeKind } from '../../shared/comparison'
import type { CompletedScanMetadata } from '../../shared/scan'
import {
  comparisonFileBindings,
  comparisonFileChangesCte,
  readComparisonInteger
} from './comparisonFileChanges'
import type { CompatiblePair } from './comparisonMatchContracts'
import { isComparisonSummary } from './comparisonSummaryContracts'
import { FILE_KIND_TOTALS_SQL } from './comparisonFileAggregates'
import { readFileAggregateRows } from './fileAggregation'
import { SnapshotAccessError } from './snapshotAccess'

function aggregateColumn(value: SQLOutputValue): bigint {
  if (typeof value !== 'bigint') throw new Error('Invalid comparison aggregate.')
  return value
}

export function readComparisonSummary(
  connection: DatabaseSync,
  compatibility: CompatiblePair,
  baseline: CompletedScanMetadata,
  target: CompletedScanMetadata
): ComparisonSummary {
  // Group once by the shared kind. SQLite returns at most five rows, with no file details.
  const statement = connection.prepare(`
    ${comparisonFileChangesCte()}
    SELECT kind, ${FILE_KIND_TOTALS_SQL}
    FROM file_changes
    GROUP BY kind
  `)
  statement.setReadBigInts(true)
  const rows = readFileAggregateRows(statement, comparisonFileBindings(compatibility))
  const counts: Record<EntryChangeKind, number> = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
    indeterminate: 0
  }
  let totalCount = 0n
  let knownDeltaCount = 0n
  let unknownDeltaCount = 0n
  let positiveDeltaBytes = 0n
  let negativeDeltaBytes = 0n
  let netKnownDeltaBytes = 0n
  let confirmedKnownDeltaBytes = 0n
  let confirmedUnknownDeltaCount = 0n
  for (const row of rows) {
    if (row.invalid_sizes !== 0n)
      throw new SnapshotAccessError(
        'SIZE_OVERFLOW',
        'The file comparison exceeds the supported size.'
      )
    if (typeof row.kind !== 'string' || !Object.hasOwn(counts, row.kind))
      throw new Error('Invalid comparison change kind.')
    const kind = row.kind as EntryChangeKind
    const count = aggregateColumn(row.path_count)
    const known = aggregateColumn(row.known_count)
    const unknown = aggregateColumn(row.unknown_count)
    const positive = aggregateColumn(row.positive_bytes)
    const negative = aggregateColumn(row.negative_bytes)
    const net = aggregateColumn(row.net_bytes)
    if (
      counts[kind] !== 0 ||
      count <= 0n ||
      known < 0n ||
      unknown < 0n ||
      count !== known + unknown ||
      positive < 0n ||
      negative > 0n ||
      net !== positive + negative ||
      (kind === 'added' && negative !== 0n) ||
      (kind === 'removed' && positive !== 0n) ||
      (kind === 'unchanged' && (positive !== 0n || negative !== 0n || unknown !== 0n))
    )
      throw new Error('Inconsistent comparison change totals.')
    counts[kind] = readComparisonInteger(count, false)
    totalCount += count
    knownDeltaCount += known
    unknownDeltaCount += unknown
    positiveDeltaBytes += positive
    negativeDeltaBytes += negative
    netKnownDeltaBytes += net
    if (kind !== 'indeterminate') {
      confirmedKnownDeltaBytes += net
      confirmedUnknownDeltaCount += unknown
    }
  }
  const before = baseline.summary
  const after = target.summary
  // Subtracting any two non-negative safe integers is exact and stays in the signed range.
  const summary: ComparisonSummary = {
    pair: compatibility.pair,
    compatibility,
    baseline,
    target,
    fileCountDelta: after.fileCount - before.fileCount,
    directoryCountDelta: after.directoryCount - before.directoryCount,
    observedSnapshotBytes: {
      baseline: before.totalBytes,
      target: after.totalBytes,
      delta: after.totalBytes - before.totalBytes
    },
    files: {
      counts,
      totalCount: readComparisonInteger(totalCount, false),
      knownDeltaCount: readComparisonInteger(knownDeltaCount, false),
      unknownDeltaCount: readComparisonInteger(unknownDeltaCount, false),
      positiveDeltaBytes: readComparisonInteger(positiveDeltaBytes, false),
      negativeDeltaBytes: readComparisonInteger(negativeDeltaBytes, true),
      netKnownDeltaBytes: readComparisonInteger(netKnownDeltaBytes, true),
      confirmedKnownDeltaBytes: readComparisonInteger(confirmedKnownDeltaBytes, true),
      confirmedUnknownDeltaCount: readComparisonInteger(confirmedUnknownDeltaCount, false)
    }
  }
  if (!isComparisonSummary(summary)) throw new Error('Inconsistent comparison summary.')
  return summary
}
