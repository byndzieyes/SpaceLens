import type { DatabaseSync } from 'node:sqlite'
import { INSIGHTS_SIZE_BUCKETS, type InsightsSizeDistribution } from '../../shared/insights'
import { aggregateInteger, readFileAggregateRows } from './fileAggregation'
import type { CompletedScan } from './payloads'

const BUCKET_AGGREGATES = INSIGHTS_SIZE_BUCKETS.map(({ id, minBytes }, index) => {
  const next = INSIGHTS_SIZE_BUCKETS[index + 1]
  const range = `size_bytes >= ${minBytes}${next ? ` AND size_bytes < ${next.minBytes}` : ''}`
  return `COUNT(*) FILTER (WHERE ${range}) AS ${id}_count,
    COALESCE(SUM(size_bytes) FILTER (WHERE ${range}), 0) AS ${id}_bytes`
}).join(',\n')

const DISTRIBUTION_SQL = `
  SELECT COUNT(size_bytes) AS known_count,
         COUNT(*) FILTER (WHERE size_bytes IS NULL) AS unknown_count,
         ${BUCKET_AGGREGATES}
  FROM entries WHERE scan_id = $scanId AND type = 'file'
`

/** One index-range scan of the publication, with a fixed set of integer accumulators. */
export function prepareFileSizeDistribution(
  connection: DatabaseSync
): (scan: CompletedScan) => InsightsSizeDistribution {
  const statement = connection.prepare(DISTRIBUTION_SQL)
  statement.setReadBigInts(true)
  return (scan) => {
    const [row] = readFileAggregateRows(statement, { $scanId: scan.id })
    const buckets = INSIGHTS_SIZE_BUCKETS.map(({ id }) => ({
      id,
      fileCount: aggregateInteger(row[`${id}_count`]),
      knownBytes: aggregateInteger(row[`${id}_bytes`])
    }))
    const knownSizeCount = aggregateInteger(row.known_count)
    const unknownSizeCount = aggregateInteger(row.unknown_count)
    const fileCount = aggregateInteger(BigInt(knownSizeCount) + BigInt(unknownSizeCount))
    // Retain exact arithmetic even if multiple individually safe buckets sum to an unsafe total.
    const knownBytes = aggregateInteger(
      buckets.reduce((sum, bucket) => sum + BigInt(bucket.knownBytes), 0n)
    )
    if (
      buckets.reduce((sum, bucket) => sum + BigInt(bucket.fileCount), 0n) !==
        BigInt(knownSizeCount) ||
      fileCount !== scan.summary.fileCount ||
      knownBytes !== scan.summary.totalBytes ||
      (unknownSizeCount > 0 && scan.summary.errorCount === 0)
    ) {
      throw new Error('File size distribution differs from the published scan summary.')
    }
    return {
      scanId: scan.id,
      incomplete: scan.summary.errorCount > 0,
      knownSizeCount,
      totals: { fileCount, knownBytes, unknownSizeCount },
      buckets
    }
  }
}
