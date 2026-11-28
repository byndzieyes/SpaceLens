import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite'
import { FILE_KIND_TOTALS_SQL } from './comparisonFileAggregates'
import { comparisonFileBindings, comparisonFileChangesCte } from './comparisonFileChanges'
import type { CompatiblePair } from './comparisonMatchContracts'
import { readFileAggregateRows } from './fileAggregation'

const FILE_BATCH_SIZE = 4096
const columns = [
  'path_count',
  'known_count',
  'unknown_count',
  'positive_bytes',
  'negative_bytes',
  'net_bytes',
  'invalid_sizes'
] as const

export class ComparisonPreparedFiles {
  private readonly boundary: StatementSync
  private readonly lastKey: StatementSync
  private readonly insert: StatementSync
  private readonly aggregate: StatementSync
  private readonly totals = new Map<string, Record<string, SQLOutputValue>>()
  private after: Uint8Array = Buffer.alloc(0)

  constructor(
    connection: DatabaseSync,
    private readonly compatibility: CompatiblePair
  ) {
    this.boundary = connection.prepare(`
      SELECT path_key FROM temp.comparison_candidate_paths
      WHERE path_key > ? ORDER BY path_key LIMIT 1 OFFSET ${FILE_BATCH_SIZE - 1}
    `)
    this.lastKey = connection.prepare(`
      SELECT path_key FROM temp.comparison_candidate_paths
      WHERE path_key > ? ORDER BY path_key DESC LIMIT 1
    `)
    this.insert = connection.prepare(`
      ${comparisonFileChangesCte(false, true)}
      INSERT INTO temp.comparison_candidate_files
      SELECT path_key, kind, reason, delta_bytes, baseline_bytes, target_bytes, baseline_parent_id, target_parent_id
      FROM file_changes
    `)
    this.aggregate = connection.prepare(`
      SELECT kind, ${FILE_KIND_TOTALS_SQL}
      FROM temp.comparison_candidate_files WHERE path_key > $after AND path_key <= $through
      GROUP BY kind
    `)
    this.aggregate.setReadBigInts(true)
  }

  /** Classify and aggregate one bounded key range, including ranges with no files. */
  advance(): boolean {
    const boundary = this.boundary.get(this.after)?.path_key
    const through = boundary ?? this.lastKey.get(this.after)?.path_key
    if (through === undefined) return true
    if (!(through instanceof Uint8Array)) throw new Error('Invalid comparison file cursor.')
    const range = { $after: this.after, $through: through }
    this.insert.run({ ...comparisonFileBindings(this.compatibility), ...range })
    for (const values of readFileAggregateRows(this.aggregate, range)) {
      const kind = values.kind
      if (typeof kind !== 'string') throw new Error('Invalid comparison aggregate kind.')
      const total = this.totals.get(kind)
      if (!total) this.totals.set(kind, values)
      else {
        for (const column of columns) {
          const previous = total[column]
          const current = values[column]
          if (typeof previous !== 'bigint' || typeof current !== 'bigint')
            throw new Error('Invalid comparison aggregate column.')
          total[column] = previous + current
        }
      }
    }
    this.after = through
    return boundary === undefined
  }

  get aggregateRows(): readonly Record<string, SQLOutputValue>[] {
    return Array.from(this.totals.values())
  }
}
