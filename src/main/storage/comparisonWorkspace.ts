import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite'
import type { ComparisonPair, ComparisonSide, ComparisonSummary } from '../../shared/comparison'
import type { ScanSnapshot } from '../../shared/snapshot'
import { createComparisonPathKey } from '../comparison/paths'
import {
  ComparisonStorageError,
  type ComparisonMatchPage,
  type CompatiblePair,
  type ResolvedComparisonMatchQuery
} from './comparisonMatchContracts'
import { MATCHED_ENTRIES } from './comparisonSql'
import { entryColumns, readEntry, readEntryType } from './entryRows'
import { bindFilesystemText, readFilesystemText } from './filesystemText'
import { isSnapshotId } from './payloads'

const TEMP_CACHE_KIB = 4 * 1024
const PATH_BATCH_SIZE = 512

const MATCH_COLUMNS = `matched.path_key, ${entryColumns('baseline', 'baseline_')},
       ${entryColumns('target', 'target_')}`

function invalidPath(cause?: unknown): ComparisonStorageError {
  return new ComparisonStorageError(
    'INVALID_COMPARISON_PATH',
    'A saved entry path or its parent is invalid for comparison.',
    { cause }
  )
}

/** Single connection-local path union. Its identity is published only after commit. */
export class ComparisonWorkspace {
  private pair: ComparisonPair | undefined
  private cachedSummary: ComparisonSummary | undefined
  private preparation:
    | {
        keyForEntry: NonNullable<ReturnType<typeof createComparisonPathKey>>
        lastId: string
      }
    | undefined
  private firstPage: StatementSync | undefined
  private nextPage: StatementSync | undefined

  constructor(private readonly connection: DatabaseSync) {
    connection.function(
      'comparison_path_key',
      { directOnly: true },
      (id, path, parentId, type, parentPath, grandparentId) =>
        this.pathKey(id, path, parentId, type, parentPath, grandparentId)
    )
  }

  matches({ baselineScanId, targetScanId }: ComparisonPair): boolean {
    return this.pair?.baselineScanId === baselineScanId && this.pair.targetScanId === targetScanId
  }

  invalidate(scanId: string): void {
    if (scanId === this.pair?.baselineScanId || scanId === this.pair?.targetScanId) this.clear()
  }

  clear(): void {
    this.pair = undefined
    this.cachedSummary = undefined
    this.firstPage = undefined
    this.nextPage = undefined
  }

  get summary(): ComparisonSummary | undefined {
    return this.cachedSummary
  }

  /** Store a summary only after its source transaction commits. */
  rememberSummary(summary: ComparisonSummary): void {
    if (!this.matches(summary.pair)) throw new Error('Comparison workspace changed.')
    this.cachedSummary = summary
  }

  /** Run inside the caller's transaction. A failed attempt leaves no usable workspace. */
  prepare(compatibility: CompatiblePair, baseline: ScanSnapshot, target: ScanSnapshot): void {
    this.clear()
    this.connection.exec(`
      CREATE TEMP TABLE IF NOT EXISTS comparison_paths (
        path_key BLOB PRIMARY KEY,
        baseline_id TEXT,
        target_id TEXT,
        CHECK (baseline_id IS NOT NULL OR target_id IS NOT NULL)
      ) STRICT, WITHOUT ROWID;
      PRAGMA temp.cache_size = -${TEMP_CACHE_KIB};
      DELETE FROM temp.comparison_paths;
    `)
    this.insertPaths('baseline', compatibility, baseline)
    this.insertPaths('target', compatibility, target)
  }

  commit(pair: ComparisonPair): void {
    this.pair = pair
  }

  list(
    compatibility: CompatiblePair,
    { after, limit }: ResolvedComparisonMatchQuery
  ): ComparisonMatchPage {
    const query =
      after === undefined
        ? (this.firstPage ??= this.preparePage('>='))
        : (this.nextPage ??= this.preparePage('>'))
    const { baselineScanId, targetScanId } = compatibility.pair
    const raw = query.all({
      $baseline: baselineScanId,
      $target: targetScanId,
      $key: bindFilesystemText(after ?? ''),
      $limit: limit + 1
    })
    const hasMore = raw.length > limit
    if (hasMore) raw.pop()
    const rows = raw.map((row) => ({
      relativePath: readFilesystemText(row.path_key, 'comparison key'),
      baseline: row.baseline_id === null ? null : readEntry(row, 'baseline_'),
      target: row.target_id === null ? null : readEntry(row, 'target_')
    }))
    return {
      compatibility,
      rows,
      limit,
      nextAfter: hasMore ? rows[rows.length - 1].relativePath : null
    }
  }

  private preparePage(boundary: '>=' | '>'): StatementSync {
    const statement = this.connection.prepare(`
      SELECT ${MATCH_COLUMNS}
      ${MATCHED_ENTRIES}
      WHERE matched.path_key ${boundary} $key
      ORDER BY matched.path_key
      LIMIT $limit
    `)
    statement.setReadBigInts(true)
    return statement
  }

  private insertPaths(
    side: ComparisonSide,
    compatibility: CompatiblePair,
    snapshot: ScanSnapshot
  ): void {
    const column = side === 'baseline' ? 'baseline_id' : 'target_id'
    const keyForEntry = createComparisonPathKey(snapshot.root.path, compatibility.pathStyle)
    if (!keyForEntry) throw invalidPath()
    const insert = this.connection.prepare(`
      INSERT INTO temp.comparison_paths (path_key, ${column})
      SELECT comparison_path_key(entry.id, entry.path, entry.parent_id, entry.type, parent.path, parent.parent_id),
             entry.id
      FROM (
        SELECT id, path, parent_id, type FROM main.entries
        WHERE scan_id = $scanId AND id > $after
        ORDER BY id LIMIT $limit
      ) AS entry
      LEFT JOIN main.entries AS parent ON parent.scan_id = $scanId AND parent.id = entry.parent_id
      WHERE 1
      ON CONFLICT (path_key) DO UPDATE SET ${column} = excluded.${column}
      WHERE comparison_paths.${column} IS NULL
    `)
    const preparation = { keyForEntry, lastId: '' }
    this.preparation = preparation
    try {
      let remaining = snapshot.entryCount
      while (remaining > 0) {
        // End the native call between batches to bound the scalar callback's temporary handles.
        const count = Math.min(PATH_BATCH_SIZE, remaining)
        const { changes } = insert.run({
          $scanId: snapshot.entries.scanId,
          $after: preparation.lastId,
          $limit: count
        })
        // A same-side collision skips a write. Never publish the resulting partial relation.
        if (BigInt(changes) !== BigInt(count)) {
          throw new ComparisonStorageError(
            'AMBIGUOUS_COMPARISON_PATH',
            'A saved snapshot has multiple entries with the same comparison path.'
          )
        }
        remaining -= count
      }
    } finally {
      this.preparation = undefined
    }
  }

  private pathKey(
    id: SQLOutputValue,
    path: SQLOutputValue,
    parentId: SQLOutputValue,
    type: SQLOutputValue,
    parentPath: SQLOutputValue,
    grandparentId: SQLOutputValue
  ): Buffer {
    const preparation = this.preparation
    if (!preparation) throw new Error('Comparison key preparation is inactive.')
    if (!isSnapshotId(id) || (parentId !== null && !isSnapshotId(parentId))) throw invalidPath()
    const { keyForEntry } = preparation
    // Valid IDs are ASCII, so JavaScript and the source index order them identically.
    if (id > preparation.lastId) preparation.lastId = id
    try {
      const key = keyForEntry({
        path: readFilesystemText(path, 'entry path'),
        parentId,
        type: readEntryType(type)
      })
      if (key !== null) {
        if (parentId === null) return bindFilesystemText(key)
        if (grandparentId === null || isSnapshotId(grandparentId)) {
          const parentKey = keyForEntry({
            path: readFilesystemText(parentPath, 'parent path'),
            parentId: grandparentId,
            type: 'directory'
          })
          // No slash means the parent is the root (the empty key).
          const separator = key.lastIndexOf('/')
          if (parentKey === (separator < 0 ? '' : key.slice(0, separator)))
            return bindFilesystemText(key)
        }
      }
    } catch (error) {
      throw invalidPath(error)
    }
    throw invalidPath()
  }
}
