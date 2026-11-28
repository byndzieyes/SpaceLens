import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite'
import type { ComparisonPair, ComparisonSide, ComparisonSummary } from '../../shared/comparison'
import type { CompletedScanMetadata } from '../../shared/scan'
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
import type {
  ComparisonPreparationRequest,
  ComparisonPreparationStatus
} from './comparisonPreparation'
import { ComparisonPreparedFiles } from './comparisonPreparedFiles'
import { summarizeComparisonRows } from './comparisonSummary'
import { SnapshotAccessError } from './snapshotAccess'
import { ComparisonPreparedDirectories } from './comparisonDirectoryAnalysis'

const TEMP_CACHE_KIB = 4 * 1024
const STAGED_TEMP_CACHE_KIB = 16 * 1024
const PATH_BATCH_SIZE = 512
const PATH_STAGE_SIZE = PATH_BATCH_SIZE * 8
const MAX_CACHED_PARENTS = 256

type PathCursor = {
  keyForEntry: NonNullable<ReturnType<typeof createComparisonPathKey>>
  parents: Map<string, string | null>
  lastId: string
}

interface PathWriter extends PathCursor {
  readonly insert: StatementSync
  readonly scanId: string
  remaining: number
}

interface WorkspaceCandidate {
  readonly id: string
  readonly compatibility: CompatiblePair
  readonly baseline: CompletedScanMetadata
  readonly target: CompletedScanMetadata
  readonly paths: readonly PathWriter[]
  readonly files: ComparisonPreparedFiles
  completed: number
  summary?: ComparisonSummary
}

function samePair(actual: ComparisonPair | undefined, requested: ComparisonPair): boolean {
  return (
    actual?.baselineScanId === requested.baselineScanId &&
    actual.targetScanId === requested.targetScanId
  )
}

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
  private owner: string | undefined
  private candidate: WorkspaceCandidate | undefined
  private cachedSummary: ComparisonSummary | undefined
  private directoriesPrepared = false
  private directoryCandidate?: {
    readonly id: string
    readonly preparation: ComparisonPreparedDirectories
    completed: number
  }
  private preparation: PathCursor | undefined
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
    return samePair(this.pair, { baselineScanId, targetScanId })
  }

  invalidate(scanId: string): void {
    const pair = this.candidate?.compatibility.pair
    if (this.candidate && pair && (scanId === pair.baselineScanId || scanId === pair.targetScanId))
      this.abandonCandidate(this.candidate.id, pair)
    if (scanId === this.pair?.baselineScanId || scanId === this.pair?.targetScanId)
      this.dropActive()
  }

  clear(): void {
    this.pair = undefined
    this.owner = undefined
    this.cachedSummary = undefined
    this.directoriesPrepared = false
    this.directoryCandidate = undefined
    this.firstPage = undefined
    this.nextPage = undefined
  }

  get summary(): ComparisonSummary | undefined {
    return this.cachedSummary
  }

  get hasPreparedFiles(): boolean {
    return this.owner !== undefined
  }

  get isPreparing(): boolean {
    return this.candidate !== undefined
  }

  get isPreparingDirectories(): boolean {
    return this.directoryCandidate !== undefined
  }

  reuse(id: string, pair: ComparisonPair): boolean {
    if (this.isPreparing || !this.matches(pair) || !this.hasPreparedFiles) return false
    this.owner = id
    return true
  }

  /** Candidate changes remain private until the transaction that swaps the tables commits. */
  begin(
    id: string,
    compatibility: CompatiblePair,
    baseline: CompletedScanMetadata,
    target: CompletedScanMetadata,
    snapshots: readonly [ScanSnapshot, ScanSnapshot]
  ): ComparisonPreparationStatus {
    if (this.candidate)
      throw new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'Comparison preparation is busy.')
    this.connection.exec(`
      CREATE TEMP TABLE comparison_candidate_paths (
        path_key BLOB PRIMARY KEY, baseline_id TEXT, target_id TEXT,
        CHECK (baseline_id IS NOT NULL OR target_id IS NOT NULL)
      ) STRICT, WITHOUT ROWID;
      CREATE TEMP TABLE comparison_candidate_files (
        path_key BLOB PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
        delta_bytes INTEGER, baseline_bytes INTEGER, target_bytes INTEGER,
        baseline_parent_id TEXT, target_parent_id TEXT
      ) STRICT, WITHOUT ROWID;
      PRAGMA temp.cache_size = -${STAGED_TEMP_CACHE_KIB};
    `)
    this.candidate = {
      id,
      compatibility,
      baseline,
      target,
      completed: 0,
      paths: [
        this.pathWriter('baseline', compatibility, snapshots[0], 'comparison_candidate_paths'),
        this.pathWriter('target', compatibility, snapshots[1], 'comparison_candidate_paths')
      ],
      files: new ComparisonPreparedFiles(this.connection, compatibility)
    }
    return { phase: 'matching', completed: 0 }
  }

  advance({ id, pair }: ComparisonPreparationRequest): ComparisonPreparationStatus {
    const candidate = this.candidate
    if (!candidate || candidate.id !== id || !samePair(candidate.compatibility.pair, pair))
      throw new SnapshotAccessError('SNAPSHOT_EXPIRED', 'Comparison preparation changed.')
    const path = candidate.paths.find((writer) => writer.remaining > 0)
    candidate.completed++
    if (path) {
      this.writePaths(path, PATH_STAGE_SIZE)
      return { phase: 'matching', completed: candidate.completed }
    }
    if (!candidate.files.advance()) return { phase: 'classifying', completed: candidate.completed }
    candidate.summary = summarizeComparisonRows(
      candidate.compatibility,
      candidate.baseline,
      candidate.target,
      candidate.files.aggregateRows
    )
    this.connection.exec(`
      DROP TABLE IF EXISTS temp.comparison_paths;
      DROP TABLE IF EXISTS temp.comparison_files;
      DROP TABLE IF EXISTS temp.comparison_directories;
      ALTER TABLE temp.comparison_candidate_paths RENAME TO comparison_paths;
      ALTER TABLE temp.comparison_candidate_files RENAME TO comparison_files;
    `)
    return { phase: 'ready', completed: candidate.completed }
  }

  promote(): void {
    const candidate = this.candidate
    if (!candidate?.summary) throw new Error('Comparison candidate is incomplete.')
    this.clear()
    this.pair = candidate.compatibility.pair
    this.owner = candidate.id
    this.cachedSummary = candidate.summary
    this.candidate = undefined
  }

  discard({ id, pair, scope }: ComparisonPreparationRequest): void {
    if (scope === 'directories') {
      this.abandonDirectories(id, pair)
      return
    }
    if (this.abandonCandidate(id, pair)) return
    if (id === this.owner && this.matches(pair)) this.dropActive()
  }

  abandonCandidate(id: string, pair: ComparisonPair): boolean {
    if (id === this.candidate?.id && samePair(this.candidate.compatibility.pair, pair)) {
      this.connection.exec(`
        DROP TABLE IF EXISTS temp.comparison_candidate_paths;
        DROP TABLE IF EXISTS temp.comparison_candidate_files;
      `)
      this.candidate = undefined
      return true
    }
    return false
  }

  private dropActive(): void {
    this.connection.exec(`
      DROP TABLE IF EXISTS temp.comparison_paths;
      DROP TABLE IF EXISTS temp.comparison_files;
      DROP TABLE IF EXISTS temp.comparison_directories;
    `)
    this.clear()
  }

  /** Store a summary only after its source transaction commits. */
  rememberSummary(summary: ComparisonSummary): void {
    if (!this.matches(summary.pair)) throw new Error('Comparison workspace changed.')
    this.cachedSummary = summary
  }

  get hasDirectories(): boolean {
    return this.directoriesPrepared
  }

  beginDirectories(id: string, pair: ComparisonPair): ComparisonPreparationStatus {
    const summary = this.cachedSummary
    if (!summary || !this.hasPreparedFiles || !this.matches(pair))
      throw new SnapshotAccessError('SNAPSHOT_EXPIRED', 'The comparison workspace changed.')
    if (this.hasDirectories) return { phase: 'ready', completed: 0 }
    if (this.directoryCandidate)
      throw new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'Directory preparation is busy.')
    this.directoryCandidate = {
      id,
      completed: 0,
      preparation: new ComparisonPreparedDirectories(
        this.connection,
        summary.compatibility,
        summary.baseline,
        summary.target,
        summary.files
      )
    }
    return { phase: 'directories', completed: 0 }
  }

  advanceDirectories(id: string, pair: ComparisonPair): ComparisonPreparationStatus {
    const candidate = this.directoryCandidate
    if (candidate?.id !== id || !this.matches(pair))
      throw new SnapshotAccessError('SNAPSHOT_EXPIRED', 'Directory preparation changed.')
    return {
      phase: candidate.preparation.advance() ? 'ready' : 'directories',
      completed: ++candidate.completed
    }
  }

  promoteDirectories(pair: ComparisonPair): void {
    this.rememberDirectories(pair)
    this.directoryCandidate = undefined
  }

  abandonDirectories(id: string, pair: ComparisonPair): void {
    if (this.directoryCandidate?.id !== id || !this.matches(pair)) return
    this.connection.exec('DROP TABLE IF EXISTS temp.comparison_directories')
    this.directoryCandidate = undefined
  }

  rememberDirectories(pair: ComparisonPair): void {
    if (!this.matches(pair)) throw new Error('Comparison workspace changed.')
    this.directoriesPrepared = true
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
    for (const [side, snapshot] of [
      ['baseline', baseline],
      ['target', target]
    ] as const) {
      const writer = this.pathWriter(side, compatibility, snapshot, 'comparison_paths')
      this.writePaths(writer, writer.remaining)
    }
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

  private pathWriter(
    side: ComparisonSide,
    compatibility: CompatiblePair,
    snapshot: ScanSnapshot,
    table: 'comparison_paths' | 'comparison_candidate_paths'
  ): PathWriter {
    const column = side === 'baseline' ? 'baseline_id' : 'target_id'
    const keyForEntry = createComparisonPathKey(snapshot.root.path, compatibility.pathStyle)
    if (!keyForEntry) throw invalidPath()
    const insert = this.connection.prepare(`
      INSERT INTO temp.${table} (path_key, ${column})
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
      WHERE ${table}.${column} IS NULL
    `)
    return {
      keyForEntry,
      parents: new Map(),
      lastId: '',
      insert,
      scanId: snapshot.entries.scanId,
      remaining: snapshot.entryCount
    }
  }

  private writePaths(writer: PathWriter, limit: number): void {
    this.preparation = writer
    try {
      let remaining = Math.min(limit, writer.remaining)
      while (remaining > 0) {
        // End the native call between batches to bound the scalar callback's temporary handles.
        const count = Math.min(PATH_BATCH_SIZE, remaining)
        const { changes } = writer.insert.run({
          $scanId: writer.scanId,
          $after: writer.lastId,
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
        writer.remaining -= count
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
    const { keyForEntry, parents } = preparation
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
          let parentKey = parents.get(parentId)
          if (parentKey === undefined) {
            parentKey = keyForEntry({
              path: readFilesystemText(parentPath, 'parent path'),
              parentId: grandparentId,
              type: 'directory'
            })
            if (parents.size === MAX_CACHED_PARENTS) parents.delete(parents.keys().next().value!)
            parents.set(parentId, parentKey)
          }
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
