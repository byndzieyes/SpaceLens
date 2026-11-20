import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type { FileEntry, ScanSession } from '../../shared/scan'
import { initializeSchema } from './schema'

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

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
  private readonly insertEntryStatement: StatementSync
  private readonly selectEntryStatement: StatementSync

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
      this.selectScanStatement = this.connection.prepare(`
        SELECT id, root_path, status, started_at, finished_at, total_bytes, file_count,
               directory_count, error_count
        FROM scans WHERE id = ?
      `)
      this.selectScanStatement.setReadBigInts(true)

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
    if (!row) return null

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
