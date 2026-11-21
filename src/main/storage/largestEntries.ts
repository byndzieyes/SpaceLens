import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite'
import {
  INSIGHTS_RANKING_LIMIT,
  type InsightsRankedEntry,
  type InsightsRankingPage,
  type InsightsRankingRequest
} from '../../shared/insights'
import { readFilesystemText } from './filesystemText'
import { isSnapshotId, type CompletedScan } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'

const RANK_ORDER = 'bytes DESC NULLS LAST, path ASC, id COLLATE BINARY ASC'
const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER)

function rankingSql(type: InsightsRankedEntry['type']): string {
  const sizeColumn = type === 'file' ? 'size_bytes' : 'aggregated_size_bytes'
  const nonRoot = type === 'directory' ? 'AND parent_id IS NOT NULL' : ''
  // The materialized ranking is shared by the page and its metadata, including empty pages.
  return `
    WITH ranked AS MATERIALIZED (
      SELECT id, parent_id, name, path, ${sizeColumn} AS bytes
      FROM entries WHERE scan_id = $scanId AND type = '${type}' ${nonRoot}
      ORDER BY ${RANK_ORDER} LIMIT ${INSIGHTS_RANKING_LIMIT}
    ), totals AS (
      SELECT COUNT(*) AS total_count, MAX(bytes) AS largest_bytes FROM ranked
    ), page AS (
      SELECT * FROM ranked ORDER BY ${RANK_ORDER} LIMIT $limit OFFSET $offset
    )
    SELECT totals.*, page.* FROM totals LEFT JOIN page ON TRUE
    ORDER BY ${RANK_ORDER}
  `
}

function readBytes(value: SQLOutputValue): number | null {
  if (value === null) return null
  if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid stored ranked size.')
  if (value > MAX_SAFE_BYTES) {
    throw new SnapshotAccessError(
      'SIZE_OVERFLOW',
      'A ranked entry exceeds the supported byte size.'
    )
  }
  return Number(value)
}

export class LargestEntries {
  private readonly files: StatementSync
  private readonly directories: StatementSync

  constructor(connection: DatabaseSync) {
    this.files = connection.prepare(rankingSql('file'))
    this.files.setReadBigInts(true)
    this.directories = connection.prepare(rankingSql('directory'))
    this.directories.setReadBigInts(true)
  }

  list(
    scan: CompletedScan,
    type: InsightsRankedEntry['type'],
    { offset, limit }: Required<InsightsRankingRequest>
  ): InsightsRankingPage {
    const statement = type === 'file' ? this.files : this.directories
    const rows = statement.all({ $scanId: scan.id, $limit: BigInt(limit), $offset: BigInt(offset) })
    const totals = rows[0]
    // Every unsafe positive size would outrank a safe one. Validate even off-page or on empty pages.
    readBytes(totals.largest_bytes)
    const totalCount = Number(totals.total_count) // COUNT of at most INSIGHTS_RANKING_LIMIT rows.
    const entries =
      totals.id === null
        ? []
        : rows.map((row) => {
            if (!isSnapshotId(row.id) || !isSnapshotId(row.parent_id)) {
              throw new Error('Published ranking contains an invalid entry reference.')
            }
            return {
              scanId: scan.id,
              id: row.id,
              parentId: row.parent_id,
              type,
              name: readFilesystemText(row.name, 'name'),
              path: readFilesystemText(row.path, 'path'),
              bytes: readBytes(row.bytes)
            }
          })
    const next = offset + entries.length
    return {
      scanId: scan.id,
      incomplete: scan.summary.errorCount > 0,
      entries,
      offset,
      limit,
      totalCount,
      nextOffset: next < totalCount ? next : null
    }
  }
}
