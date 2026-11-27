import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync
} from 'node:sqlite'
import type { ScanHistoryItem, ScanHistoryPage, ScanHistorySort } from '../../shared/history'
import type { TrendPoint } from '../../shared/trends'
import type {
  InsightsCategories,
  InsightsExtensionPage,
  InsightsExtensionRequest,
  InsightsRankedEntry,
  InsightsRankingPage,
  InsightsRankingRequest,
  InsightsSizeDistribution,
  InsightsObservations
} from '../../shared/insights'
import type { FileEntry, ScanSession } from '../../shared/scan'
import {
  comparisonMetadataForStoredScan,
  comparisonSeries,
  evaluateComparisonCompatibility
} from '../comparison/compatibility'
import { readTrendBatchRequest, TREND_BATCH_SIZE, type TrendBatch } from './trendsContracts'
import { isComparisonPathKey } from '../comparison/paths'
import {
  MAX_SCAN_TREEMAP_ENTRIES,
  type ScanDirectoryPage,
  type ScanDirectoryRequest,
  type ScanDirectoryTreemap,
  type ScanDirectoryTreemapRequest,
  type ScanEntryRequest,
  type ScanSnapshot,
  type ScanSnapshotAvailability
} from '../../shared/snapshot'
import {
  readExtensionRequest,
  readRankingRequest,
  readScanHistoryQuery,
  readSnapshotId,
  SnapshotAccessError,
  validateSnapshotRequest,
  validateTreemapRequest
} from './snapshotAccess'
import {
  isSnapshotId,
  readCompletedScanDuration,
  validateBuildingScan,
  validateScanPublication,
  validateStorageBatch,
  type BuildingScan,
  type CompletedScan,
  type CommittedSnapshotDeletion,
  type RetentionCandidateRequest,
  type RetentionCandidate,
  type PruneSnapshotRequest,
  type FinalizedDirectory,
  type StorageBatchOperation
} from './payloads'
import { prepareSnapshotValidation } from './publication'
import {
  nextPublicationSequence,
  readPublicationCounter,
  recordPublicationSequence
} from './publicationSequence'
import { initializeSchema } from './schema'
import { bindFilesystemText, readFilesystemText } from './filesystemText'
import { PublishedAnalytics } from './publishedAnalytics'
import {
  ComparisonStorageError,
  readComparisonMatchQuery,
  type ComparisonMatchPage,
  type CompatiblePair
} from './comparisonMatchContracts'
import { readComparisonFileQuery, type ComparisonFileResult } from './comparisonFileContracts'
import { readComparisonFileChanges } from './comparisonFileChanges'
import {
  readComparisonDirectoryQuery,
  type ComparisonDirectoryResult
} from './comparisonDirectoryContracts'
import {
  listComparisonDirectories,
  prepareComparisonDirectories,
  reconcileDirectoryRoot
} from './comparisonDirectoryAnalysis'
import { readComparisonSummary } from './comparisonSummary'
import { readComparisonPair } from './comparisonSummaryContracts'
import { ComparisonWorkspace } from './comparisonWorkspace'
import type { ComparisonPair, ComparisonSummary } from '../../shared/comparison'
import { entryColumns, MAX_SAFE_INTEGER, readEntry, readInteger, readText } from './entryRows'

const SQLITE_PAGE_CACHE_KIB = 64 * 1024
const SCAN_COLUMNS = `id, root_path, status, started_at, finished_at, total_bytes, file_count,
         directory_count, error_count`
const SELECT_SCAN = `SELECT ${SCAN_COLUMNS}, publication_sequence FROM scans`
const LATEST_SCAN =
  "FROM scans WHERE status = 'completed' ORDER BY publication_sequence DESC LIMIT 1"
const HISTORY_ORDER: Record<ScanHistorySort, string> = {
  newest: 'publication_sequence DESC',
  oldest: 'publication_sequence ASC',
  'size-asc': 'total_bytes ASC, publication_sequence DESC',
  'size-desc': 'total_bytes DESC, publication_sequence DESC'
}
const ENTRY_COLUMNS = entryColumns('entry')
const SELECT_ENTRY = `SELECT ${ENTRY_COLUMNS} FROM entries AS entry`
const DEEP_DIRECTORY_OFFSET = 10_000
const MAX_VALIDATED_SNAPSHOTS = 8
const TREEMAP_BYTES = `CASE type WHEN 'file' THEN size_bytes WHEN 'directory' THEN aggregated_size_bytes END`
const TREEMAP_CHILDREN = `FROM entries WHERE scan_id = $scanId AND parent_id = $entryId`
const TREEMAP_TOTALS = `SELECT COUNT(*) AS child_count, COALESCE(SUM(bytes), 0) AS known_bytes,
  COUNT(*) FILTER (WHERE bytes IS NULL) AS unknown_count,
  COUNT(*) FILTER (WHERE bytes = 0) AS zero_count`

function treemapSizeOverflow(): SnapshotAccessError {
  return new SnapshotAccessError('SIZE_OVERFLOW', 'The directory exceeds the supported byte total.')
}

function bindInteger(value: number, column: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${column} must be a non-negative safe integer.`)
  }
  return BigInt(value)
}

function readScan(row: Record<string, SQLOutputValue>): ScanSession {
  const scan = {
    id: readText(row.id, 'scan ID'),
    rootPath: readFilesystemText(row.root_path, 'root path'),
    startedAt: readText(row.started_at, 'startedAt'),
    summary: {
      totalBytes: readInteger(row.total_bytes, 'totalBytes'),
      fileCount: readInteger(row.file_count, 'fileCount'),
      directoryCount: readInteger(row.directory_count, 'directoryCount'),
      errorCount: readInteger(row.error_count, 'errorCount')
    }
  }

  switch (row.status) {
    case 'running':
      if (row.finished_at !== null) throw new Error('Stored running scan has a finish time.')
      return { ...scan, status: row.status, finishedAt: null }
    case 'completed':
    case 'cancelled':
    case 'failed':
      return { ...scan, status: row.status, finishedAt: readText(row.finished_at, 'finishedAt') }
    default:
      throw new Error('Stored scan has an invalid status.')
  }
}

function validateEntryReference(entry: FileEntry): FileEntry {
  if (!isSnapshotId(entry.id) || (entry.parentId !== null && !isSnapshotId(entry.parentId))) {
    throw new Error('Published snapshot contains an invalid entry reference.')
  }
  return entry
}

function requireCompletedScan(scan: ScanSession): CompletedScan {
  if (scan.status !== 'completed') throw new Error('Invalid persisted publication status.')
  return { ...scan, status: scan.status }
}

function invalidSavedSnapshot(): SnapshotAccessError {
  return new SnapshotAccessError(
    'SNAPSHOT_UNAVAILABLE',
    'This saved snapshot failed integrity checks.'
  )
}

function historyItem(scan: CompletedScan, latestId: string | null): ScanHistoryItem {
  return {
    ...scan,
    durationMs: readCompletedScanDuration(scan),
    isLatest: scan.id === latestId,
    incomplete: scan.summary.errorCount > 0
  }
}

function readLegacyPublication(statement: StatementSync): CompletedScan | null {
  const [row, other] = statement.all()
  if (other) throw new Error('The database has more than one completed scan.')
  return row ? requireCompletedScan(readScan(row)) : null
}

function readSequencedScan(row: Record<string, SQLOutputValue>): ScanSession {
  const sequence = row.publication_sequence
  if (
    row.status === 'completed' ? typeof sequence !== 'bigint' || sequence <= 0n : sequence !== null
  ) {
    throw new Error('Invalid scan publication sequence.')
  }
  return readScan(row)
}

function validatePublishedRoot(scan: CompletedScan, root: FileEntry | null): FileEntry {
  if (!root || root.type !== 'directory' || root.parentId !== null || root.path !== scan.rootPath) {
    throw new Error('The expected scan root directory is missing or invalid.')
  }
  if (root.aggregatedSizeBytes !== scan.summary.totalBytes) {
    throw new Error('The scan root is unfinished or its total differs from the scan summary.')
  }
  return root
}

/** Both schema versions use the same tree and recovery checks inside the startup transaction. */
function recoverScans(connection: DatabaseSync, published: CompletedScan | null): void {
  if (
    connection
      .prepare("SELECT 1 FROM scans WHERE status NOT IN ('running', 'completed') LIMIT 1")
      .get()
  ) {
    throw new Error('The database contains an unexpected persisted scan status.')
  }
  // Parent faults in a retained historical tree are checked when that tree is opened.
  // Orphan scan IDs and invalid references in Latest or abandoned builds still fail recovery.
  if (
    connection
      .prepare(
        `
    SELECT 1 FROM entries AS child
    LEFT JOIN scans AS scan ON scan.id = child.scan_id
    WHERE scan.id IS NULL OR (
      (scan.status = 'running' OR scan.id = ?) AND child.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM entries AS parent
        WHERE parent.scan_id = child.scan_id AND parent.id = child.parent_id AND parent.type = 'directory'
      )
    )
    LIMIT 1
  `
      )
      .get(published?.id ?? null)
  ) {
    throw new Error('The database contains invalid scan or entry references.')
  }
  if (published) {
    const selectRoot = connection.prepare(
      `${SELECT_ENTRY} WHERE entry.scan_id = ? AND entry.parent_id IS NULL`
    )
    selectRoot.setReadBigInts(true)
    const row = selectRoot.get(published.id)
    const publication = { scan: published, rootEntryId: row?.id }
    validateScanPublication(publication)
    validatePublishedRoot(published, row ? readEntry(row) : null)
    prepareSnapshotValidation(connection)(published)
  }
  // No legitimate scanner can be running under the profile lock during startup recovery.
  connection.exec("DELETE FROM scans WHERE status = 'running'")
}

function inTransaction(
  connection: DatabaseSync,
  operation: () => undefined,
  begin: 'BEGIN IMMEDIATE' | 'BEGIN' = 'BEGIN IMMEDIATE'
): void {
  connection.exec(begin)
  try {
    if (operation() !== undefined) {
      throw new TypeError(
        'SQLite transaction callbacks must run synchronously and return undefined.'
      )
    }
    connection.exec('COMMIT')
  } catch (error) {
    if (connection.isTransaction) {
      try {
        connection.exec('ROLLBACK')
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Could not roll back SQLite transaction.',
          {
            cause: rollbackError
          }
        )
      }
    }
    throw error
  }
}

/** Owns one synchronous connection. Construct and close it on the same thread. */
export class ScanDatabase {
  private historyGeneration = 0n
  private readonly connection: DatabaseSync
  private readonly analytics: PublishedAnalytics
  private readonly comparison: ComparisonWorkspace
  private readonly insertScanStatement: StatementSync
  private readonly selectScanStatement: StatementSync
  private readonly selectLatestScanStatement: StatementSync
  private readonly selectLatestScanIdStatement: StatementSync
  private readonly selectOtherBuildingStatement: StatementSync
  private readonly completeScanStatement: StatementSync
  private readonly deleteBuildingScanStatement: StatementSync
  private readonly deleteCompletedScanStatement: StatementSync
  private readonly selectRootIdStatement: StatementSync
  private readonly validateSnapshot: (scan: CompletedScan) => bigint
  private readonly validatedSnapshots = new Map<string, ScanSnapshot>()
  private validatedLatestId: string | undefined
  private readonly insertEntryStatement: StatementSync
  private readonly selectEntryStatement: StatementSync
  private readonly countSnapshotEntriesStatement: StatementSync
  private readonly countDirectoryChildrenStatement: StatementSync
  private readonly listDirectoryPageStatement: StatementSync
  private readonly listDeepDirectoryPageStatement: StatementSync
  private readonly selectTreemapStatement: StatementSync
  private readonly selectFinalizedDirectoryStatement: StatementSync
  private readonly selectUnfinalizedChildStatement: StatementSync
  private readonly finalizeDirectoryStatement: StatementSync

  constructor(path: string) {
    // Foreign keys are per connection. Keep SQLite's default journal mode for new databases
    // and preserve the mode on reopen. Revisit WAL when the storage access pattern is known.
    let connection: DatabaseSync | undefined
    try {
      connection = new DatabaseSync(path, { open: false, enableForeignKeyConstraints: true })
      this.connection = connection
      this.connection.open()
      if (this.connection.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
        throw new Error('SQLite foreign-key enforcement is unavailable.')
      }
      // A bounded connection-local cache limits page churn while scanning and recovering.
      this.connection.exec(`PRAGMA main.cache_size = -${SQLITE_PAGE_CACHE_KIB}`)
      this.connection.exec('PRAGMA temp_store = FILE')
      inTransaction(this.connection, () =>
        initializeSchema(this.connection, () => {
          const legacy = this.connection.prepare(
            `SELECT ${SCAN_COLUMNS} FROM scans WHERE status = 'completed' LIMIT 2`
          )
          legacy.setReadBigInts(true)
          const published = readLegacyPublication(legacy)
          recoverScans(this.connection, published)
          return published?.id ?? null
        })
      )
      this.analytics = new PublishedAnalytics(this.connection)
      this.comparison = new ComparisonWorkspace(this.connection)
      // BLOB byte offsets can split UTF-16 code units. Match decoded text at code-unit boundaries.
      this.connection.function(
        'history_path_contains',
        { deterministic: true, directOnly: true },
        (path, text) =>
          Number(
            readFilesystemText(path, 'root path').includes(readFilesystemText(text, 'search text'))
          )
      )

      this.insertScanStatement = this.connection.prepare(`
        INSERT INTO scans (
          id, root_path, status, started_at, finished_at, total_bytes, file_count,
          directory_count, error_count, publication_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.selectScanStatement = this.connection.prepare(`${SELECT_SCAN} WHERE id = ?`)
      this.selectScanStatement.setReadBigInts(true)
      this.selectLatestScanStatement = this.connection.prepare(
        `SELECT ${SCAN_COLUMNS}, publication_sequence ${LATEST_SCAN}`
      )
      this.selectLatestScanStatement.setReadBigInts(true)
      this.selectLatestScanIdStatement = this.connection.prepare(`SELECT id ${LATEST_SCAN}`)
      this.selectOtherBuildingStatement = this.connection.prepare(`
        SELECT id FROM scans WHERE status = 'running' AND id <> ? LIMIT 1
      `)
      this.completeScanStatement = this.connection.prepare(`
        UPDATE scans SET status = 'completed', finished_at = ?, total_bytes = ?,
                         file_count = ?, directory_count = ?, error_count = ?, publication_sequence = ?
        WHERE id = ? AND status = 'running'
      `)
      this.deleteBuildingScanStatement = this.connection.prepare(
        "DELETE FROM scans WHERE id = ? AND status = 'running'"
      )
      this.deleteCompletedScanStatement = this.connection.prepare(
        "DELETE FROM scans WHERE id = ? AND status = 'completed'"
      )
      this.selectRootIdStatement = this.connection.prepare(
        'SELECT id FROM entries WHERE scan_id = ? AND parent_id IS NULL'
      )
      this.validateSnapshot = prepareSnapshotValidation(this.connection)

      this.insertEntryStatement = this.connection.prepare(`
        INSERT INTO entries (
          scan_id, id, parent_id, name, path, type, size_bytes, aggregated_size_bytes,
          created_at, modified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.selectEntryStatement = this.connection.prepare(`
        ${SELECT_ENTRY} WHERE entry.scan_id = ? AND entry.id = ?
      `)
      this.selectEntryStatement.setReadBigInts(true)
      this.countSnapshotEntriesStatement = this.connection.prepare(`
        SELECT COUNT(*) AS entry_count,
               COUNT(*) FILTER (WHERE type = 'file') AS file_count,
               COUNT(*) FILTER (WHERE type = 'directory') AS directory_count
        FROM entries WHERE scan_id = ?
      `)
      this.countSnapshotEntriesStatement.setReadBigInts(true)
      this.countDirectoryChildrenStatement = this.connection.prepare(`
        SELECT COUNT(*) AS child_count FROM entries WHERE scan_id = ? AND parent_id = ?
      `)
      this.countDirectoryChildrenStatement.setReadBigInts(true)
      // Sort UTF-16BE name keys and ASCII snapshot IDs, then fetch metadata for just the page.
      this.listDirectoryPageStatement = this.connection.prepare(`
        WITH page AS MATERIALIZED (
          SELECT id, name FROM entries WHERE scan_id = $scanId AND parent_id = $entryId
          ORDER BY name, id COLLATE BINARY LIMIT $limit OFFSET $offset
        )
        ${SELECT_ENTRY}
        JOIN page ON entry.scan_id = $scanId AND entry.id = page.id
        ORDER BY page.name, page.id COLLATE BINARY
      `)
      this.listDirectoryPageStatement.setReadBigInts(true)
      // At deep offsets SQLite's LIMIT sort can maintain offset + limit keys in a temporary
      // B-tree. Ranking uses SQLite's full sorter and passes only the page keys to the join.
      this.listDeepDirectoryPageStatement = this.connection.prepare(`
        WITH page AS MATERIALIZED (
          SELECT id, position FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY name, id COLLATE BINARY) AS position
            FROM entries WHERE scan_id = $scanId AND parent_id = $entryId
          )
          WHERE position > $offset AND position <= $offset + $limit
          LIMIT $limit
        )
        ${SELECT_ENTRY}
        JOIN page ON entry.scan_id = $scanId AND entry.id = page.id
        ORDER BY page.position
      `)
      this.listDeepDirectoryPageStatement.setReadBigInts(true)

      // Rank only keys and sizes. The metadata join reads no more than the requested Top-N.
      this.selectTreemapStatement = this.connection.prepare(`
        WITH top_entries AS MATERIALIZED (
          SELECT id, name, ${TREEMAP_BYTES} AS bytes ${TREEMAP_CHILDREN}
          ORDER BY bytes DESC NULLS LAST, name, id COLLATE BINARY LIMIT $limit
        ), directory_totals AS (
          ${TREEMAP_TOTALS} FROM (SELECT ${TREEMAP_BYTES} AS bytes ${TREEMAP_CHILDREN})
        ), top_totals AS (
          ${TREEMAP_TOTALS} FROM top_entries
        )
        SELECT ${ENTRY_COLUMNS},
               directory_totals.child_count AS total_count,
               directory_totals.known_bytes AS total_known_bytes,
               directory_totals.unknown_count AS unknown_count,
               directory_totals.child_count - top_totals.child_count AS other_count,
               directory_totals.known_bytes - top_totals.known_bytes AS other_known_bytes,
               directory_totals.unknown_count - top_totals.unknown_count AS other_unknown_count,
               directory_totals.zero_count - top_totals.zero_count AS other_zero_count
        FROM directory_totals CROSS JOIN top_totals
        LEFT JOIN top_entries ON TRUE
        LEFT JOIN entries AS entry ON entry.scan_id = $scanId AND entry.id = top_entries.id
        ORDER BY top_entries.bytes DESC NULLS LAST, top_entries.name, top_entries.id COLLATE BINARY
      `)
      this.selectTreemapStatement.setReadBigInts(true)

      this.selectFinalizedDirectoryStatement = this.connection.prepare(`
        SELECT 1 FROM entries
        WHERE scan_id = ? AND id = ? AND type = 'directory' AND aggregated_size_bytes IS NOT NULL
      `)
      this.selectUnfinalizedChildStatement = this.connection.prepare(`
        SELECT 1 FROM entries
        WHERE scan_id = ? AND parent_id = ? AND type = 'directory' AND aggregated_size_bytes IS NULL
        LIMIT 1
      `)
      this.finalizeDirectoryStatement = this.connection.prepare(`
        UPDATE entries SET aggregated_size_bytes = ? WHERE scan_id = ? AND id = ?
      `)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const message = `Could not open the scan database ${JSON.stringify(path)}. ${reason}`
      try {
        if (connection?.isOpen) connection.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], `${message} SQLite cleanup failed.`, {
          cause: closeError
        })
      }
      throw new Error(message, { cause: error })
    }
  }

  insertScan(scan: ScanSession): void {
    this.requireOpen()
    if (scan.status !== 'completed') {
      this.insertScanRow(scan, null)
      return
    }
    // Low-level callers may already be seeding a scan and its entries in a transaction.
    const insertCompleted = (): undefined => {
      const sequence = nextPublicationSequence(this.connection)
      this.insertScanRow(scan, sequence)
      recordPublicationSequence(this.connection, sequence)
    }
    if (this.connection.isTransaction) insertCompleted()
    else this.transaction(insertCompleted)
    this.historyGeneration++
  }

  private insertScanRow(scan: ScanSession, sequence: bigint | null): void {
    const { summary } = scan
    this.insertScanStatement.run(
      scan.id,
      bindFilesystemText(scan.rootPath),
      scan.status,
      scan.startedAt,
      scan.finishedAt,
      bindInteger(summary.totalBytes, 'totalBytes'),
      bindInteger(summary.fileCount, 'fileCount'),
      bindInteger(summary.directoryCount, 'directoryCount'),
      bindInteger(summary.errorCount, 'errorCount'),
      sequence
    )
  }

  /** Internal by-ID metadata lookup, including retained and running scans. */
  getScan(id: string): ScanSession | null {
    this.requireOpen()
    const row = this.selectScanStatement.get(id)
    return row ? readSequencedScan(row) : null
  }

  /** Startup only. SQLite has already resolved any interrupted journal on open. */
  recoverStorage(): void {
    let latest!: CompletedScan | null
    this.transaction(() => {
      readPublicationCounter(this.connection)
      latest = this.getPublishedScan()
      recoverScans(this.connection, latest)
    })
    this.validatedLatestId = latest?.id
    this.validatedSnapshots.clear()
    this.analytics.clear()
  }

  beginScan(scan: BuildingScan): void {
    validateBuildingScan(scan)
    this.transaction(() => {
      if (this.getScan(scan.id)) throw new Error(`Scan ${scan.id} already exists.`)
      this.requireOnlyBuildingScan(scan.id)
      readPublicationCounter(this.connection)
      this.insertScan(scan)
    })
  }

  publishScan(scan: CompletedScan, rootEntryId: string): CompletedScan {
    validateScanPublication({ scan, rootEntryId })
    let published!: CompletedScan
    this.transaction(() => {
      const building = this.getScan(scan.id)
      if (!building || building.status !== 'running') {
        throw new Error(`Scan ${scan.id} is not a building scan.`)
      }
      this.requireOnlyBuildingScan(scan.id)
      if (scan.rootPath !== building.rootPath || scan.startedAt !== building.startedAt) {
        throw new Error('Completed scan metadata does not match the building scan.')
      }

      this.validatePublishedTree(scan, rootEntryId)

      const sequence = nextPublicationSequence(this.connection)
      const { totalBytes, fileCount, directoryCount, errorCount } = scan.summary
      const result = this.completeScanStatement.run(
        scan.finishedAt,
        bindInteger(totalBytes, 'totalBytes'),
        bindInteger(fileCount, 'fileCount'),
        bindInteger(directoryCount, 'directoryCount'),
        bindInteger(errorCount, 'errorCount'),
        sequence,
        scan.id
      )
      if (result.changes !== 1) throw new Error(`Could not promote scan ${scan.id}.`)
      recordPublicationSequence(this.connection, sequence)
      const stored = this.getScan(scan.id)
      if (!stored) throw new Error('Could not read the promoted scan.')
      published = requireCompletedScan(stored)
    })
    this.validatedLatestId = published.id
    this.historyGeneration++
    return published
  }

  discardBuildingScan(scanId: string): void {
    if (!isSnapshotId(scanId)) throw new TypeError('Discard requires a valid scan ID.')
    this.transaction(() => {
      if (this.deleteBuildingScanStatement.run(scanId).changes !== 1) {
        throw new Error(`Scan ${scanId} is not a building scan.`)
      }
    })
  }

  getRetentionCandidate({
    limit,
    protectedScanIds
  }: RetentionCandidateRequest): RetentionCandidate {
    this.requireOpen()
    const exclusions =
      protectedScanIds.length === 0
        ? ''
        : `AND id NOT IN (${protectedScanIds.map(() => '?').join(', ')})`
    const statement = this.connection.prepare(`
      WITH stats AS (
        SELECT (SELECT COUNT(*) FROM scans WHERE status = 'completed') AS total_count,
               EXISTS (SELECT 1 FROM scans WHERE status = 'running') AS building
      ), latest AS (
        SELECT id, publication_sequence ${LATEST_SCAN}
      )
      SELECT total_count, building, latest.id AS latest_scan_id,
             CASE WHEN total_count > ? AND NOT building THEN (
               SELECT id FROM scans
               WHERE status = 'completed' AND publication_sequence < latest.publication_sequence
               ${exclusions}
               ORDER BY publication_sequence ASC LIMIT 1
             ) END AS candidate_scan_id
      FROM stats LEFT JOIN latest ON TRUE
    `)
    statement.setReadBigInts(true)
    const row = statement.get(limit, ...protectedScanIds)!
    const { latest_scan_id: latestScanId, candidate_scan_id: candidateScanId } = row
    if (
      (latestScanId !== null && !isSnapshotId(latestScanId)) ||
      (candidateScanId !== null && !isSnapshotId(candidateScanId))
    )
      throw new Error('Invalid snapshot reference in retention metadata.')
    return {
      totalCount: readInteger(row.total_count, 'retained snapshot count'),
      latestScanId,
      candidateScanId,
      building: row.building === 1n
    }
  }

  pruneSnapshot(request: PruneSnapshotRequest): CommittedSnapshotDeletion | null {
    return this.deleteSnapshot({ scanId: request.scanId }, request)
  }

  deleteSnapshot(request: unknown): CommittedSnapshotDeletion
  deleteSnapshot(
    request: unknown,
    retention: RetentionCandidateRequest
  ): CommittedSnapshotDeletion | null
  deleteSnapshot(
    request: unknown,
    retention?: RetentionCandidateRequest
  ): CommittedSnapshotDeletion | null {
    const scanId = readSnapshotId(request)
    let deleted: CommittedSnapshotDeletion | null = null
    let deletedLatest = false
    this.transaction(() => {
      if (retention && this.getRetentionCandidate(retention).candidateScanId !== scanId) return
      const scan = this.getScan(scanId)
      if (!scan)
        throw new SnapshotAccessError('SNAPSHOT_EXPIRED', 'This saved scan no longer exists.')
      if (scan.status !== 'completed') {
        throw new SnapshotAccessError(
          'SNAPSHOT_UNAVAILABLE',
          'Only completed snapshots can be deleted.'
        )
      }
      readCompletedScanDuration(requireCompletedScan(scan))
      readPublicationCounter(this.connection)
      deletedLatest = this.getLatestScanId() === scanId
      if (this.deleteCompletedScanStatement.run(scanId).changes !== 1)
        throw new Error('Could not delete the completed snapshot.')
      const latestCompleted = this.getPublishedScan()
      if (latestCompleted) readCompletedScanDuration(latestCompleted)
      deleted = { scanId, latestCompleted, latestCompletedScanId: latestCompleted?.id ?? null }
    })
    if (deleted) {
      this.historyGeneration++
      this.validatedSnapshots.delete(scanId)
      this.analytics.invalidate(scanId)
      this.comparison.invalidate(scanId)
    }
    if (deletedLatest) this.validatedLatestId = undefined
    return deleted
  }

  /** Latest completed scan by committed publication order. */
  getPublishedScan(): CompletedScan | null {
    this.requireOpen()
    const row = this.selectLatestScanStatement.get()
    return row ? requireCompletedScan(readSequencedScan(row)) : null
  }

  listScanHistory(request: unknown): ScanHistoryPage {
    this.requireOpen()
    const { offset, limit, sort, rootPath, rootPathContains } = readScanHistoryQuery(request)
    const predicates = ["status = 'completed'"]
    const bindings: SQLInputValue[] = []
    if (rootPath !== undefined) {
      predicates.push('root_path = ?')
      bindings.push(bindFilesystemText(rootPath))
    }
    if (rootPathContains !== undefined) {
      predicates.push('history_path_contains(root_path, ?) = 1')
      bindings.push(bindFilesystemText(rootPathContains))
    }
    const where = `WHERE ${predicates.join(' AND ')}`

    let page!: ScanHistoryPage
    inTransaction(
      this.connection,
      () => {
        const count = this.connection.prepare(`SELECT COUNT(*) AS total_count FROM scans ${where}`)
        count.setReadBigInts(true)
        const totalCount = readInteger(count.get(...bindings)?.total_count ?? null, 'history total')
        const latestCompletedScanId = this.getLatestScanId()
        const items: ScanHistoryItem[] = []
        if (offset < totalCount) {
          const select = this.connection.prepare(
            `${SELECT_SCAN} ${where} ORDER BY ${HISTORY_ORDER[sort]} LIMIT ? OFFSET ?`
          )
          select.setReadBigInts(true)
          for (const row of select.all(...bindings, limit, offset)) {
            items.push(
              historyItem(requireCompletedScan(readSequencedScan(row)), latestCompletedScanId)
            )
          }
        }
        const end = offset + items.length
        page = {
          items,
          offset,
          limit,
          totalCount,
          nextOffset: end < totalCount ? end : null,
          latestCompletedScanId
        }
      },
      'BEGIN'
    )
    return page
  }

  getScanHistoryMetadata(request: unknown): ScanHistoryItem {
    this.requireOpen()
    const scanId = readSnapshotId(request)
    let item!: ScanHistoryItem
    inTransaction(
      this.connection,
      () => {
        item = historyItem(this.requireSavedScan(scanId), this.getLatestScanId())
      },
      'BEGIN'
    )
    return item
  }

  /** Indexed keyset read. Normalize no more than one batch of completed roots per admission. */
  readTrendBatch(request: unknown): TrendBatch {
    this.requireOpen()
    const { selection, before, pointLimit } = readTrendBatchRequest(request)
    const latest = this.getPublishedScan()
    const anchor = selection.mode === 'snapshot' ? this.requireSavedScan(selection.scanId) : latest
    const series =
      selection.mode === 'series' ? selection.series : anchor && comparisonSeries(anchor.rootPath)
    if (selection.mode !== 'series' && anchor && !series)
      throw new SnapshotAccessError(
        'SNAPSHOT_UNAVAILABLE',
        'This snapshot has no compatible trend root.'
      )

    const header = {
      series,
      latestCompletedScanId: latest?.id ?? null,
      generation: this.historyGeneration
    }
    if (!series || !latest) return { ...header, nextBefore: null, matchedCount: 0, points: [] }

    // Root spellings use the original UTF-16 bytes. Comparing raw root_path would miss aliases.
    const select = this.connection.prepare(
      `${SELECT_SCAN} WHERE status = 'completed'${before === undefined ? '' : ' AND publication_sequence < ?'}
       ORDER BY publication_sequence DESC LIMIT ${TREND_BATCH_SIZE + 1}`
    )
    select.setReadBigInts(true)
    const rows = before === undefined ? select.all() : select.all(before)
    const points: TrendPoint[] = []
    let matchedCount = 0
    for (const row of rows.slice(0, TREND_BATCH_SIZE)) {
      const key = comparisonSeries(readFilesystemText(row.root_path, 'root path'))
      if (
        key?.normalizedRoot !== series.normalizedRoot ||
        key.pathStyle !== series.pathStyle ||
        key.traversalPolicy !== series.traversalPolicy
      )
        continue
      matchedCount++
      if (points.length >= pointLimit) continue
      const scan = requireCompletedScan(readSequencedScan(row))
      readCompletedScanDuration(scan)
      const { totalBytes, fileCount, directoryCount, errorCount } = scan.summary
      points.push({
        id: scan.id,
        finishedAt: scan.finishedAt,
        totalBytes,
        fileCount,
        directoryCount,
        incomplete: errorCount > 0
      })
    }
    const nextBefore =
      rows.length > TREND_BATCH_SIZE ? rows[TREND_BATCH_SIZE - 1].publication_sequence : null
    if (nextBefore !== null && (typeof nextBefore !== 'bigint' || nextBefore <= 0n))
      throw new Error('Invalid metadata publication cursor.')
    return { ...header, nextBefore, matchedCount, points }
  }

  /** Internal keyset page of observations. All source reads belong to the same transaction. */
  listComparisonMatches(request: unknown): ComparisonMatchPage {
    const query = readComparisonMatchQuery(request)
    return this.withComparisonWorkspace(query, query.after, (compatibility) =>
      this.comparison.list(compatibility, query)
    )
  }

  listComparisonFileChanges(request: unknown): ComparisonFileResult {
    const query = readComparisonFileQuery(request)
    return this.withComparisonWorkspace(query, query.relativeDirectory, (compatibility) =>
      readComparisonFileChanges(
        this.connection,
        compatibility,
        query,
        this.comparison.summary?.files.totalCount
      )
    )
  }

  getComparisonSummary(request: unknown): ComparisonSummary {
    const pair = readComparisonPair(request)
    const summary = this.withComparisonWorkspace(
      pair,
      undefined,
      (compatibility, baseline, target) => {
        if (this.comparison.summary) return this.comparison.summary
        const summary = readComparisonSummary(this.connection, compatibility, baseline, target)
        if (this.comparison.hasDirectories) reconcileDirectoryRoot(this.connection, summary.files)
        return summary
      }
    )
    this.comparison.rememberSummary(summary)
    return summary
  }

  listComparisonDirectoryChanges(request: unknown): ComparisonDirectoryResult {
    const query = readComparisonDirectoryQuery(request)
    let prepared = false
    const page = this.withComparisonWorkspace(
      query,
      query.relativeDirectory,
      (compatibility, baseline, target) => {
        if (!this.comparison.hasDirectories && query.kinds?.length !== 0) {
          prepareComparisonDirectories(
            this.connection,
            compatibility,
            baseline,
            target,
            this.comparison.summary?.files
          )
          prepared = true
        }
        return listComparisonDirectories(this.connection, compatibility, query)
      }
    )
    if (prepared) this.comparison.rememberDirectories(page.pair)
    return page
  }

  private withComparisonWorkspace<T>(
    { baselineScanId, targetScanId }: ComparisonPair,
    path: string | undefined,
    read: (compatibility: CompatiblePair, baseline: CompletedScan, target: CompletedScan) => T
  ): T {
    this.requireOpen()
    const pair = { baselineScanId, targetScanId }
    if (baselineScanId === targetScanId) {
      throw new ComparisonStorageError(
        'INCOMPATIBLE_SNAPSHOTS',
        'Comparing the same snapshot is unsupported (SAME_SNAPSHOT).'
      )
    }

    let page!: T
    let validated: readonly [ScanSnapshot, ScanSnapshot] | undefined
    inTransaction(
      this.connection,
      () => {
        const baseline = this.requireCompletedMetadata(baselineScanId)
        const target = this.requireCompletedMetadata(targetScanId)
        const compatibility = evaluateComparisonCompatibility(
          pair,
          comparisonMetadataForStoredScan(baseline),
          comparisonMetadataForStoredScan(target)
        )
        if (compatibility.status === 'incompatible') {
          throw new ComparisonStorageError(
            'INCOMPATIBLE_SNAPSHOTS',
            `These saved scans are incompatible (${compatibility.reason.code}).`
          )
        }
        if (path !== undefined && !isComparisonPathKey(path, compatibility.pathStyle)) {
          throw new SnapshotAccessError('INVALID_REQUEST', 'The comparison path is invalid.')
        }
        if (!this.comparison.matches(pair)) {
          validated = [this.resolveSavedSnapshot(baseline), this.resolveSavedSnapshot(target)]
          this.comparison.prepare(compatibility, ...validated)
        }
        page = read(compatibility, baseline, target)
      },
      'BEGIN'
    )
    if (validated) {
      this.comparison.commit(pair)
      for (const snapshot of validated) this.rememberValidatedSnapshot(snapshot)
    }
    return page
  }

  private getLatestScanId(): string | null {
    const row = this.selectLatestScanIdStatement.get()
    if (!row) return null
    if (!isSnapshotId(row.id)) throw new Error('Invalid latest scan ID.')
    return row.id
  }

  getScanSnapshot(): ScanSnapshotAvailability {
    const scan = this.getPublishedScan()
    return {
      snapshot: scan ? this.resolveSavedSnapshot(scan) : null,
      unavailable: null
    }
  }

  openSavedSnapshot(request: unknown): ScanSnapshot {
    const scan = this.requireCompletedMetadata(readSnapshotId(request))
    // An explicit view can outlive this publication's time as Latest.
    if (scan.id === this.validatedLatestId) {
      const snapshot = this.readSavedSnapshot(scan)
      if (!this.connection.isTransaction) this.rememberValidatedSnapshot(snapshot)
      return snapshot
    }
    return this.resolveSavedSnapshot(scan)
  }

  private resolveSavedSnapshot(scan: CompletedScan): ScanSnapshot {
    if (scan.id === this.validatedLatestId) return this.readSavedSnapshot(scan)
    const cached = this.validatedSnapshots.get(scan.id)
    if (cached) {
      this.validatedSnapshots.delete(scan.id)
      this.validatedSnapshots.set(scan.id, cached)
      return cached
    }

    try {
      let snapshot!: ScanSnapshot
      const validate = (): undefined => {
        snapshot = this.readSavedSnapshot(scan, true)
        return undefined
      }
      // Internal callers may already have a transaction. Only cache independent committed reads.
      if (this.connection.isTransaction) {
        validate()
        return snapshot
      }
      inTransaction(this.connection, validate, 'BEGIN')
      this.rememberValidatedSnapshot(snapshot)
      return snapshot
    } catch {
      throw invalidSavedSnapshot()
    }
  }

  private rememberValidatedSnapshot(snapshot: ScanSnapshot): void {
    const { scanId } = snapshot.entries
    this.validatedSnapshots.delete(scanId)
    this.validatedSnapshots.set(scanId, snapshot)
    if (this.validatedSnapshots.size > MAX_VALIDATED_SNAPSHOTS) {
      const oldest = this.validatedSnapshots.keys().next().value!
      this.validatedSnapshots.delete(oldest)
    }
  }

  private readSavedSnapshot(scan: CompletedScan, fullValidation = false): ScanSnapshot {
    const publication = { scan, rootEntryId: this.selectRootIdStatement.get(scan.id)?.id }
    validateScanPublication(publication)
    const root = this.readPublishedRoot(scan, publication.rootEntryId)
    let count: SQLOutputValue
    if (fullValidation) {
      count = this.validateSnapshot(scan)
    } else {
      const counts = this.countSnapshotEntriesStatement.get(scan.id)
      if (
        counts?.file_count !== BigInt(scan.summary.fileCount) ||
        counts.directory_count !== BigInt(scan.summary.directoryCount)
      ) {
        throw new Error('Persisted entry counts differ from the scan summary.')
      }
      count = counts.entry_count
    }
    return {
      entries: { scanId: scan.id, rootEntryId: root.id },
      root,
      completedAt: scan.finishedAt,
      summary: scan.summary,
      entryCount: readInteger(count, 'entryCount'),
      incomplete: scan.summary.errorCount > 0
    }
  }

  getScanEntry(request: ScanEntryRequest): FileEntry {
    validateSnapshotRequest(request, false)
    return this.requireExplorerEntry(request)
  }

  listScanDirectory(request: ScanDirectoryRequest): ScanDirectoryPage {
    validateSnapshotRequest(request, true)
    const directory = this.requireExplorerEntry(request)
    if (directory.type !== 'directory') {
      throw new SnapshotAccessError('NOT_DIRECTORY', 'Entry is not a directory.')
    }
    const { scanId, entryId: directoryId, offset, limit } = request
    const counts = this.countDirectoryChildrenStatement.get(scanId, directoryId)
    const totalCount = readInteger(counts?.child_count ?? null, 'totalCount')
    const length = Math.min(limit, Math.max(0, totalCount - offset))
    const statement =
      offset >= DEEP_DIRECTORY_OFFSET
        ? this.listDeepDirectoryPageStatement
        : this.listDirectoryPageStatement
    const entries =
      length === 0
        ? []
        : statement
            .all({ $scanId: scanId, $entryId: directoryId, $limit: length, $offset: offset })
            .map((row) => validateEntryReference(readEntry(row)))
    const end = offset + length
    return { scanId, directoryId, entries, totalCount, nextOffset: end < totalCount ? end : null }
  }

  getScanDirectoryTreemap(request: ScanDirectoryTreemapRequest): ScanDirectoryTreemap {
    validateTreemapRequest(request)
    const directory = this.requireExplorerEntry(request)
    if (directory.type !== 'directory') {
      throw new SnapshotAccessError('NOT_DIRECTORY', 'Entry is not a directory.')
    }
    const { scanId, entryId: directoryId, limit = MAX_SCAN_TREEMAP_ENTRIES } = request
    let rows: Record<string, SQLOutputValue>[]
    try {
      rows = this.selectTreemapStatement.all({
        $scanId: scanId,
        $entryId: directoryId,
        $limit: limit
      })
    } catch (error) {
      // Integer SUM is exact and SQLite rejects an overflow of its signed 64-bit range.
      if (error instanceof Error && error.message === 'integer overflow')
        throw treemapSizeOverflow()
      throw error
    }
    // The aggregate row also exists for empty directories, with NULL entry columns.
    const counts = rows[0]
    if (
      typeof counts.total_known_bytes === 'bigint' &&
      counts.total_known_bytes > MAX_SAFE_INTEGER
    ) {
      throw treemapSizeOverflow()
    }
    const totalCount = readInteger(counts.total_count, 'totalCount')
    const entries =
      totalCount === 0 ? [] : rows.map((row) => validateEntryReference(readEntry(row)))
    const count = readInteger(counts.other_count, 'other.count')
    return {
      scanId,
      directoryId,
      entries,
      totalCount,
      individualCount: entries.length,
      unknownCount: readInteger(counts.unknown_count, 'unknownCount'),
      other:
        count === 0
          ? null
          : {
              count,
              knownBytes: readInteger(counts.other_known_bytes, 'other.knownBytes'),
              unknownCount: readInteger(counts.other_unknown_count, 'other.unknownCount'),
              zeroCount: readInteger(counts.other_zero_count, 'other.zeroCount')
            }
    }
  }

  getInsightsCategories(scanId: string): InsightsCategories {
    return this.analytics.getCategories(this.requireValidatedScan(scanId))
  }

  getInsightsSizeDistribution(scanId: string): InsightsSizeDistribution {
    return this.analytics.getSizeDistribution(this.requireValidatedScan(scanId))
  }

  getInsightsObservations(scanId: string): InsightsObservations {
    return this.analytics.getObservations(this.requireValidatedScan(scanId))
  }

  listInsightsExtensions(request: InsightsExtensionRequest): InsightsExtensionPage {
    const page = readExtensionRequest(request)
    return this.analytics.listExtensions(this.requireValidatedScan(page.scanId), page)
  }

  listInsightsLargest(
    request: InsightsRankingRequest,
    type: InsightsRankedEntry['type']
  ): InsightsRankingPage {
    const page = readRankingRequest(request)
    return this.analytics.listLargest(this.requireValidatedScan(page.scanId), type, page)
  }

  requireValidatedScan(scanId: string): CompletedScan {
    const scan = this.requireCompletedMetadata(scanId)
    if (scanId !== this.validatedLatestId) this.resolveSavedSnapshot(scan)
    return scan
  }

  private requireSavedScan(scanId: string): CompletedScan {
    const scan = this.getScan(scanId)
    if (!scan)
      throw new SnapshotAccessError('SNAPSHOT_EXPIRED', 'This saved scan no longer exists.')
    if (scan.status === 'completed') return requireCompletedScan(scan)
    throw new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'This scan has no available snapshot.')
  }

  private requireCompletedMetadata(scanId: string): CompletedScan {
    try {
      const scan = this.requireSavedScan(scanId)
      readCompletedScanDuration(scan)
      return scan
    } catch (error) {
      if (error instanceof SnapshotAccessError) throw error
      throw invalidSavedSnapshot()
    }
  }

  private requireExplorerEntry({ scanId, entryId }: ScanEntryRequest): FileEntry {
    this.requireValidatedScan(scanId)
    const entry = this.getEntry(scanId, entryId)
    if (!entry) {
      throw new SnapshotAccessError('ENTRY_NOT_FOUND', 'Entry does not exist in this snapshot.')
    }
    return validateEntryReference(entry)
  }

  private validatePublishedTree(scan: CompletedScan, rootEntryId: string): void {
    this.readPublishedRoot(scan, rootEntryId)
    this.validateSnapshot(scan)
  }

  private readPublishedRoot(scan: CompletedScan, rootEntryId: string): FileEntry {
    return validatePublishedRoot(scan, this.getEntry(scan.id, rootEntryId))
  }

  private requireOnlyBuildingScan(scanId: string): void {
    const other = this.selectOtherBuildingStatement.get(scanId)
    if (other) throw new Error(`Building scan ${other.id} is already active.`)
  }

  insertEntry(entry: FileEntry): void {
    this.requireOpen()
    this.insertEntryStatement.run(
      entry.scanId,
      entry.id,
      entry.parentId,
      bindFilesystemText(entry.name),
      bindFilesystemText(entry.path),
      entry.type,
      entry.sizeBytes === null ? null : bindInteger(entry.sizeBytes, 'sizeBytes'),
      entry.aggregatedSizeBytes === null
        ? null
        : bindInteger(entry.aggregatedSizeBytes, 'aggregatedSizeBytes'),
      entry.createdAt,
      entry.modifiedAt
    )
  }

  getEntry(scanId: string, id: string): FileEntry | null {
    this.requireOpen()
    const row = this.selectEntryStatement.get(scanId, id)
    return row ? readEntry(row) : null
  }

  /** Persist discoveries and finalizations in order, acknowledging only a committed batch. */
  applyBatch(scanId: string, operations: readonly StorageBatchOperation[]): void {
    validateStorageBatch({ scanId, operations })
    this.transaction(() => {
      const scan = this.getScan(scanId)
      if (!scan) throw new Error(`Storage batch scan ${scanId} does not exist.`)
      if (scan.status !== 'running') throw new Error(`Storage batch scan ${scanId} is not running.`)

      for (const operation of operations) {
        const { entry } = operation
        if (operation.type === 'entry') {
          if (
            entry.parentId === null &&
            (entry.type !== 'directory' || entry.path !== scan.rootPath)
          ) {
            throw new Error(`Storage batch entry ${entry.id} does not match the scan root.`)
          }
          this.requireUnfinalizedParent(entry)
          this.insertEntry(entry)
        } else {
          this.finalizeDirectory(operation.entry)
        }
      }
    })
  }

  private requireUnfinalizedParent(entry: FileEntry): void {
    // The immediate foreign key on insert still enforces existence and same-scan directory identity.
    if (
      entry.parentId !== null &&
      this.selectFinalizedDirectoryStatement.get(entry.scanId, entry.parentId)
    ) {
      throw new Error(`Parent directory ${entry.parentId} is already finalized.`)
    }
  }

  private finalizeDirectory(entry: FinalizedDirectory): void {
    const { scanId, id, aggregatedSizeBytes } = entry
    const stored = this.getEntry(scanId, id)
    if (!stored) throw new Error(`Cannot finalize missing entry ${id}.`)
    if (stored.type !== 'directory') throw new Error(`Entry ${id} is not a directory.`)
    if (stored.aggregatedSizeBytes !== null)
      throw new Error(`Directory ${id} is already finalized.`)
    const metadata = ['parentId', 'name', 'path', 'createdAt', 'modifiedAt'] as const
    if (metadata.some((key) => stored[key] !== entry[key])) {
      throw new Error(`Finalization for directory ${id} differs from its discovery metadata.`)
    }
    this.requireUnfinalizedParent(entry)
    if (this.selectUnfinalizedChildStatement.get(scanId, id)) {
      throw new Error(`Directory ${id} has an unfinalized child directory.`)
    }

    this.finalizeDirectoryStatement.run(
      bindInteger(aggregatedSizeBytes, 'aggregatedSizeBytes'),
      scanId,
      id
    )
  }

  /** Run synchronous writes atomically on this connection. A thrown error rolls them back. */
  transaction(operation: () => undefined): void {
    this.requireOpen()
    inTransaction(this.connection, operation)
  }

  close(): void {
    this.analytics.clear()
    this.validatedSnapshots.clear()
    this.comparison.clear()
    if (!this.connection.isOpen) return
    if (this.connection.isTransaction) throw new Error('Cannot close during a SQLite transaction.')
    this.connection.close()
  }

  private requireOpen(): void {
    if (!this.connection.isOpen) throw new Error('The scan database is closed.')
  }
}
