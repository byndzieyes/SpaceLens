import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type { FileEntry, ScanSession } from '../../shared/scan'
import {
  isSnapshotId,
  validateBuildingScan,
  validateScanPublication,
  validateStorageBatch,
  type BuildingScan,
  type CompletedScan,
  type FinalizedDirectory,
  type StorageBatchOperation
} from './payloads'
import { prepareSnapshotValidation } from './publication'
import { initializeSchema } from './schema'

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const SELECT_SCAN = `
  SELECT id, root_path, status, started_at, finished_at, total_bytes, file_count,
         directory_count, error_count FROM scans
`

function bindInteger(value: number, column: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${column} must be a non-negative safe integer.`)
  }
  return BigInt(value)
}

function readInteger(value: SQLOutputValue, column: string): number {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_SAFE_INTEGER) {
    throw new RangeError(`Stored ${column} is outside the non-negative safe integer range.`)
  }
  return Number(value)
}

function readText(value: SQLOutputValue, column: string): string {
  if (typeof value !== 'string') throw new TypeError(`Stored ${column} must be text.`)
  return value
}

// Big-endian UTF-16 BLOBs preserve every filesystem code unit, including lone surrogates.
// SQLite's byte ordering for these names also matches the existing UTF-16 ordering contract.
function bindFilesystemText(value: string): Buffer {
  return Buffer.from(value, 'utf16le').swap16()
}

function readFilesystemText(value: SQLOutputValue, column: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength % 2 !== 0) {
    throw new TypeError(`Stored ${column} must be a UTF-16 BLOB.`)
  }
  return Buffer.from(value).swap16().toString('utf16le')
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

function inTransaction(connection: DatabaseSync, operation: () => undefined): void {
  connection.exec('BEGIN IMMEDIATE')
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
  private readonly connection: DatabaseSync
  private readonly insertScanStatement: StatementSync
  private readonly selectScanStatement: StatementSync
  private readonly selectPublishedStatement: StatementSync
  private readonly selectOtherBuildingStatement: StatementSync
  private readonly completeScanStatement: StatementSync
  private readonly deleteScanStatement: StatementSync
  private readonly selectRootIdStatement: StatementSync
  private readonly selectUnexpectedStatusStatement: StatementSync
  private readonly checkForeignKeysStatement: StatementSync
  private readonly deleteInterruptedScansStatement: StatementSync
  private readonly validateSnapshot: (scan: CompletedScan) => void
  private readonly insertEntryStatement: StatementSync
  private readonly selectEntryStatement: StatementSync
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
      inTransaction(this.connection, () => initializeSchema(this.connection))

      this.insertScanStatement = this.connection.prepare(`
        INSERT INTO scans (
          id, root_path, status, started_at, finished_at, total_bytes, file_count,
          directory_count, error_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.selectScanStatement = this.connection.prepare(`${SELECT_SCAN} WHERE id = ?`)
      this.selectScanStatement.setReadBigInts(true)
      this.selectPublishedStatement = this.connection.prepare(
        `${SELECT_SCAN} WHERE status = 'completed' LIMIT 2`
      )
      this.selectPublishedStatement.setReadBigInts(true)
      this.selectOtherBuildingStatement = this.connection.prepare(`
        SELECT id FROM scans WHERE status = 'running' AND id <> ? LIMIT 1
      `)
      this.completeScanStatement = this.connection.prepare(`
        UPDATE scans SET status = 'completed', finished_at = ?, total_bytes = ?,
                         file_count = ?, directory_count = ?, error_count = ?
        WHERE id = ? AND status = 'running'
      `)
      this.deleteScanStatement = this.connection.prepare(
        'DELETE FROM scans WHERE id = ? AND status = ?'
      )
      this.selectRootIdStatement = this.connection.prepare(
        'SELECT id FROM entries WHERE scan_id = ? AND parent_id IS NULL'
      )
      this.selectUnexpectedStatusStatement = this.connection.prepare(
        "SELECT status FROM scans WHERE status NOT IN ('running', 'completed') LIMIT 1"
      )
      this.checkForeignKeysStatement = this.connection.prepare('PRAGMA foreign_key_check')
      this.deleteInterruptedScansStatement = this.connection.prepare(
        "DELETE FROM scans WHERE status = 'running'"
      )
      this.validateSnapshot = prepareSnapshotValidation(this.connection)

      this.insertEntryStatement = this.connection.prepare(`
        INSERT INTO entries (
          scan_id, id, parent_id, name, path, type, size_bytes, aggregated_size_bytes,
          created_at, modified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.selectEntryStatement = this.connection.prepare(`
        SELECT scan_id, id, parent_id, name, path, type, size_bytes, aggregated_size_bytes,
               created_at, modified_at
        FROM entries WHERE scan_id = ? AND id = ?
      `)
      this.selectEntryStatement.setReadBigInts(true)

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
      bindInteger(summary.errorCount, 'errorCount')
    )
  }

  getScan(id: string): ScanSession | null {
    this.requireOpen()
    const row = this.selectScanStatement.get(id)
    return row ? readScan(row) : null
  }

  /** Startup only. SQLite has already resolved any interrupted journal on open. */
  recoverStorage(): void {
    this.transaction(() => {
      const published = this.getPublishedScan()
      if (this.selectUnexpectedStatusStatement.get()) {
        throw new Error('The database contains an unexpected persisted scan status.')
      }
      if (this.checkForeignKeysStatement.get()) {
        throw new Error('The database contains invalid scan or entry references.')
      }
      if (published) {
        const publication = {
          scan: published,
          rootEntryId: this.selectRootIdStatement.get(published.id)?.id
        }
        validateScanPublication(publication)
        this.validatePublishedTree(publication.scan, publication.rootEntryId)
      }
      // No legitimate scanner can be running under the profile lock during startup recovery.
      this.deleteInterruptedScansStatement.run()
    })
  }

  beginScan(scan: BuildingScan): void {
    validateBuildingScan(scan)
    this.transaction(() => {
      if (this.getScan(scan.id)) throw new Error(`Scan ${scan.id} already exists.`)
      this.requireOnlyBuildingScan(scan.id)
      this.getPublishedScan() // Refuse an ambiguous pre-existing publication before starting work.
      this.insertScan(scan)
    })
  }

  publishScan(scan: CompletedScan, rootEntryId: string): void {
    validateScanPublication({ scan, rootEntryId })
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

      const previous = this.getPublishedScan()
      const { totalBytes, fileCount, directoryCount, errorCount } = scan.summary
      const result = this.completeScanStatement.run(
        scan.finishedAt,
        bindInteger(totalBytes, 'totalBytes'),
        bindInteger(fileCount, 'fileCount'),
        bindInteger(directoryCount, 'directoryCount'),
        bindInteger(errorCount, 'errorCount'),
        scan.id
      )
      if (result.changes !== 1) throw new Error(`Could not promote scan ${scan.id}.`)
      if (previous && this.deleteScanStatement.run(previous.id, 'completed').changes !== 1) {
        throw new Error(`Could not retire published scan ${previous.id}.`)
      }
    })
  }

  discardBuildingScan(scanId: string): void {
    if (!isSnapshotId(scanId)) throw new TypeError('Discard requires a valid scan ID.')
    this.transaction(() => {
      if (this.deleteScanStatement.run(scanId, 'running').changes !== 1) {
        throw new Error(`Scan ${scanId} is not a building scan.`)
      }
    })
  }

  getPublishedScan(): CompletedScan | null {
    this.requireOpen()
    const rows = this.selectPublishedStatement.all()
    if (rows.length > 1) throw new Error('The database has more than one completed scan.')
    if (!rows[0]) return null
    const scan = readScan(rows[0])
    if (scan.status !== 'completed') throw new Error('Invalid persisted publication status.')
    return { ...scan, status: scan.status }
  }

  private validatePublishedTree(scan: CompletedScan, rootEntryId: string): void {
    const root = this.getEntry(scan.id, rootEntryId)
    if (
      !root ||
      root.type !== 'directory' ||
      root.parentId !== null ||
      root.path !== scan.rootPath
    ) {
      throw new Error('The expected scan root directory is missing or invalid.')
    }
    if (root.aggregatedSizeBytes !== scan.summary.totalBytes) {
      throw new Error('The scan root is unfinished or its total differs from the scan summary.')
    }
    this.validateSnapshot(scan)
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
    if (!row) return null

    const { type } = row
    if (
      type !== 'file' &&
      type !== 'directory' &&
      type !== 'symlink' &&
      type !== 'other' &&
      type !== 'unknown'
    ) {
      throw new Error('Stored entry has an invalid type.')
    }
    return {
      id: readText(row.id, 'entry ID'),
      scanId: readText(row.scan_id, 'scan ID'),
      parentId: row.parent_id === null ? null : readText(row.parent_id, 'parent ID'),
      name: readFilesystemText(row.name, 'name'),
      path: readFilesystemText(row.path, 'path'),
      type,
      sizeBytes: row.size_bytes === null ? null : readInteger(row.size_bytes, 'sizeBytes'),
      aggregatedSizeBytes:
        row.aggregated_size_bytes === null
          ? null
          : readInteger(row.aggregated_size_bytes, 'aggregatedSizeBytes'),
      createdAt: row.created_at === null ? null : readText(row.created_at, 'createdAt'),
      modifiedAt: row.modified_at === null ? null : readText(row.modified_at, 'modifiedAt')
    }
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
    if (!this.connection.isOpen) return
    if (this.connection.isTransaction) throw new Error('Cannot close during a SQLite transaction.')
    this.connection.close()
  }

  private requireOpen(): void {
    if (!this.connection.isOpen) throw new Error('The scan database is closed.')
  }
}
