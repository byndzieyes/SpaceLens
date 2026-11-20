// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SCANNER_BATCH_SIZE } from '../src/main/scanner/workerProtocol'
import { ScanDatabase } from '../src/main/storage/database'
import type { StorageBatchOperation } from '../src/main/storage/payloads'
import type { FileEntry, ScanSession, ScanStatus } from '../src/shared/scan'

const rootPath = resolve('fixture')
const startedAt = '2026-11-20T15:00:00.000+02:00'
const finishedAt = '2026-11-20T13:01:00.000Z'

function scan(id = 'scan-a', status: ScanStatus = 'completed'): ScanSession {
  const metadata = {
    id,
    rootPath,
    startedAt,
    summary: { totalBytes: 20, fileCount: 2, directoryCount: 1, errorCount: 1 }
  }
  return status === 'running'
    ? { ...metadata, status, finishedAt: null }
    : { ...metadata, status, finishedAt }
}

function root(scanId = 'scan-a'): FileEntry {
  return {
    id: 'root',
    scanId,
    parentId: null,
    name: 'fixture',
    path: rootPath,
    type: 'directory',
    sizeBytes: null,
    aggregatedSizeBytes: 20,
    createdAt: null,
    modifiedAt: finishedAt
  }
}

function file(scanId = 'scan-a', id = 'file'): FileEntry {
  return {
    id,
    scanId,
    parentId: 'root',
    name: 'fixture.txt',
    path: join(rootPath, 'fixture.txt'),
    type: 'file',
    sizeBytes: 20,
    aggregatedSizeBytes: null,
    createdAt: startedAt,
    modifiedAt: null
  }
}

let tempDirectory: string
let databasePath: string
let database: ScanDatabase | undefined

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'spacelens-scan-database-'))
  databasePath = join(tempDirectory, 'scans.sqlite')
})

afterEach(() => {
  try {
    database?.close()
  } finally {
    database = undefined
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

function open(): ScanDatabase {
  database = new ScanDatabase(databasePath)
  return database
}

function inspectDatabase(inspect: (connection: DatabaseSync) => void): void {
  const connection = new DatabaseSync(databasePath)
  try {
    inspect(connection)
  } finally {
    connection.close()
  }
}

test('creates a version 1 database with two strict tables and the default rollback journal', () => {
  const db = open()
  expect(db.getScan('missing')).toBeNull()
  expect(db.getEntry('missing', 'root')).toBeNull()
  db.close()

  inspectDatabase((sql) => {
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(sql.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete')
    expect(
      sql
        .prepare(
          "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name IN ('entries', 'scans') ORDER BY name"
        )
        .all()
    ).toEqual([
      { name: 'entries', strict: 1 },
      { name: 'scans', strict: 1 }
    ])
  })
})

test('repeated initialization and idempotent close preserve all stored metadata', () => {
  const db = open()
  db.transaction(() => {
    db.insertScan(scan())
    db.insertEntry(root())
    db.insertEntry(file())
  })
  db.close()
  db.close()
  expect(() => db.getScan('scan-a')).toThrow('The scan database is closed.')
  expect(() => db.insertEntry(file())).toThrow('The scan database is closed.')

  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = open()
    expect(reopened.getScan('scan-a')).toEqual(scan())
    expect(reopened.getEntry('scan-a', 'root')).toEqual(root())
    expect(reopened.getEntry('scan-a', 'file')).toEqual(file())
    reopened.close()
  }
  inspectDatabase((sql) => expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(1))
})

test('refuses a future version and leaves the database intact', () => {
  const db = open()
  db.insertScan(scan())
  db.close()
  inspectDatabase((sql) => sql.exec('PRAGMA user_version = 2'))

  expect(() => open()).toThrow('Unsupported SQLite schema version 2.')
  inspectDatabase((sql) => {
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    expect(sql.prepare('SELECT id FROM scans').get()?.id).toBe('scan-a')
  })
})

test('rejects a modified version 1 schema', () => {
  open().close()
  inspectDatabase((sql) => {
    sql.exec('DROP INDEX entries_by_parent; CREATE INDEX entries_by_parent ON entries(id)')
  })

  expect(() => open()).toThrow('Unexpected definition for entries_by_parent.')
  inspectDatabase((sql) => expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(1))
})

test('leaves a non-empty unversioned database alone', () => {
  inspectDatabase((sql) => sql.exec('CREATE TABLE other_data (value TEXT)'))

  expect(() => open()).toThrow('Cannot initialize a non-empty unversioned database.')
  inspectDatabase((sql) => {
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(0)
    expect(sql.prepare('SELECT name FROM sqlite_schema WHERE type = ?').all('table')).toEqual([
      { name: 'other_data' }
    ])
  })
})

test('rolls back both the version marker and the DDL when initialization fails', () => {
  const exec = DatabaseSync.prototype.exec
  const failure = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    exec.call(this, sql)
    if (sql === 'PRAGMA user_version = 1') throw new Error('Simulated initialization failure.')
  })

  try {
    expect(() => open()).toThrow('Simulated initialization failure.')
  } finally {
    failure.mockRestore()
  }
  inspectDatabase((sql) => {
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(0)
    expect(sql.prepare('SELECT name FROM sqlite_schema').all()).toEqual([])
  })
  expect(open().getScan('scan-a')).toBeNull()
})

test('provides the database path and underlying failure when opening fails', () => {
  const missingPath = join(tempDirectory, 'missing-directory', 'scans.sqlite')
  expect(() => new ScanDatabase(missingPath)).toThrow(
    /Could not open the scan database.*scans\.sqlite/
  )
})

test('round-trips running and terminal scans and enforces finish-time nullability', () => {
  const db = open()
  const statuses = ['running', 'completed', 'cancelled', 'failed'] as const
  for (const status of statuses) {
    const metadata = scan(`scan-${status}`, status)
    db.insertScan(metadata)
    expect(db.getScan(metadata.id)).toEqual(metadata)
  }

  const invalid = { ...scan('bad'), finishedAt: null } as ScanSession
  expect(() => db.insertScan(invalid)).toThrow('scan_finish_time')
  expect(db.getScan('bad')).toBeNull()
})

test('round-trips every entry type, nullable metadata, and known zero values', () => {
  const db = open()
  db.insertScan(scan())
  const entries: FileEntry[] = [
    { ...root(), aggregatedSizeBytes: null },
    {
      ...root(),
      id: 'empty',
      parentId: 'root',
      name: 'empty',
      path: join(rootPath, 'empty'),
      aggregatedSizeBytes: 0
    },
    { ...file(), sizeBytes: 0 },
    { ...file('scan-a', 'unknown-size'), sizeBytes: null, createdAt: null },
    ...(['symlink', 'other', 'unknown'] as const).map((type) => ({
      ...file('scan-a', type),
      type,
      sizeBytes: null
    }))
  ]
  for (const entry of entries) {
    db.insertEntry(entry)
    expect(db.getEntry(entry.scanId, entry.id)).toEqual(entry)
  }
})

test('looks up repeated entry IDs by both scan and entry identity', () => {
  const db = open()
  const first = file('scan-a')
  const second = { ...file('scan-b'), sizeBytes: 0 }
  for (const entry of [first, second]) {
    db.insertScan(scan(entry.scanId))
    db.insertEntry(root(entry.scanId))
    db.insertEntry(entry)
  }
  expect(db.getEntry('scan-a', 'file')).toEqual(first)
  expect(db.getEntry('scan-b', 'file')).toEqual(second)
  expect(db.getEntry('scan-c', 'file')).toBeNull()
  expect(() => db.insertEntry(first)).toThrow('UNIQUE constraint failed')
})

test('rejects missing scans, missing parents, cross-scan parents, and non-directory parents', () => {
  const db = open()
  expect(() => db.insertEntry(root())).toThrow('FOREIGN KEY constraint failed')
  db.insertScan(scan('scan-a'))
  db.insertScan(scan('scan-b'))
  expect(() => db.insertEntry(file('scan-a'))).toThrow('FOREIGN KEY constraint failed')
  db.insertEntry(root('scan-a'))
  expect(() => db.insertEntry(file('scan-b'))).toThrow('FOREIGN KEY constraint failed')
  db.insertEntry(file('scan-a'))
  expect(() => db.insertEntry({ ...file('scan-a', 'child'), parentId: 'file' })).toThrow(
    'FOREIGN KEY constraint failed'
  )
  expect(db.getEntry('scan-a', 'child')).toBeNull()
})

test('enforces root uniqueness and entry size and parent semantics', () => {
  const db = open()
  db.insertScan(scan())
  expect(() => db.insertEntry({ ...file(), parentId: null })).toThrow('entry_root_directory')
  db.insertEntry(root())
  expect(() => db.insertEntry({ ...root(), id: 'second-root' })).toThrow('UNIQUE constraint failed')
  expect(() => db.insertEntry({ ...file(), parentId: 'file' })).toThrow('entry_parent_identity')
  expect(() => db.insertEntry({ ...file(), type: 'symlink' })).toThrow('entry_file_size')
  expect(() => db.insertEntry({ ...file(), aggregatedSizeBytes: 0 })).toThrow(
    'entry_directory_size'
  )
})

test('stores safe bounds exactly and detects exact 64-bit values outside the shared contract', () => {
  const db = open()
  const maxSafe = Number.MAX_SAFE_INTEGER
  const metadata = {
    ...scan(),
    summary: { totalBytes: maxSafe, fileCount: 1, directoryCount: 1, errorCount: 0 }
  }
  const sourceFile = { ...file(), sizeBytes: maxSafe }
  const sourceRoot = { ...root(), aggregatedSizeBytes: maxSafe }
  db.insertScan(metadata)
  db.insertEntry(sourceRoot)
  db.insertEntry(sourceFile)
  expect(db.getScan('scan-a')).toEqual(metadata)
  expect(db.getEntry('scan-a', 'root')).toEqual(sourceRoot)
  expect(db.getEntry('scan-a', 'file')).toEqual(sourceFile)
  db.close()

  const maxSigned = 9223372036854775807n
  inspectDatabase((sql) => {
    sql.prepare('UPDATE scans SET total_bytes = ? WHERE id = ?').run(maxSigned, 'scan-a')
    sql
      .prepare('UPDATE entries SET size_bytes = ? WHERE scan_id = ? AND id = ?')
      .run(maxSigned, 'scan-a', 'file')
    const read = sql.prepare('SELECT total_bytes, typeof(total_bytes) AS storage_type FROM scans')
    read.setReadBigInts(true)
    expect(read.get()).toEqual({ total_bytes: maxSigned, storage_type: 'integer' })
  })

  const reopened = open()
  expect(() => reopened.getScan('scan-a')).toThrow('Stored totalBytes is outside')
  expect(() => reopened.getEntry('scan-a', 'file')).toThrow('Stored sizeBytes is outside')
})

test.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, NaN, Infinity])(
  'rejects invalid numeric input (%s) before writing',
  (value) => {
    const db = open()
    const metadata = scan()
    expect(() =>
      db.insertScan({ ...metadata, summary: { ...metadata.summary, fileCount: value } })
    ).toThrow('fileCount must be a non-negative safe integer.')
    expect(db.getScan('scan-a')).toBeNull()
    db.insertScan(metadata)
    expect(() => db.insertEntry({ ...root(), aggregatedSizeBytes: value })).toThrow(
      'aggregatedSizeBytes must be a non-negative safe integer.'
    )
    db.insertEntry(root())
    expect(() => db.insertEntry({ ...file(), sizeBytes: value })).toThrow(
      'sizeBytes must be a non-negative safe integer.'
    )
    expect(db.getEntry('scan-a', 'file')).toBeNull()
  }
)

test('binds unusual names and paths verbatim and preserves UTF-16 name ordering', () => {
  const db = open()
  const unusualRoot = `${rootPath} '資料' \ud800`
  const name = "📁 '); DROP TABLE entries; -- \ud800.txt"
  const metadata = { ...scan(), rootPath: unusualRoot }
  const rootEntry = { ...root(), path: unusualRoot }
  const entry = { ...file(), name, path: join(unusualRoot, name) }
  db.insertScan(metadata)
  db.insertEntry(rootEntry)
  db.insertEntry(entry)
  for (const [id, name] of [
    ['bmp', '\ue000'],
    ['supplementary', '\u{10000}']
  ]) {
    db.insertEntry({ ...file('scan-a', id), name, path: join(unusualRoot, name) })
  }
  expect(db.getScan('scan-a')).toEqual(metadata)
  expect(db.getScan("scan-a' OR 1 = 1 --")).toBeNull()
  expect(db.getEntry('scan-a', 'root')).toEqual(rootEntry)
  expect(db.getEntry('scan-a', 'file')).toEqual(entry)
  expect(db.getEntry('scan-a', "file' OR 1 = 1 --")).toBeNull()
  db.close()

  inspectDatabase((sql) => {
    expect(
      sql
        .prepare('SELECT id FROM entries WHERE id IN (?, ?) ORDER BY name')
        .all('bmp', 'supplementary')
    ).toEqual([{ id: 'supplementary' }, { id: 'bmp' }])
  })
})

test('rolls back writes to both tables on statement failure and can start a new transaction', () => {
  const db = open()
  expect(() =>
    db.transaction(() => {
      db.insertScan(scan())
      db.insertEntry(root())
      db.insertEntry({ ...file(), parentId: 'missing' })
    })
  ).toThrow('FOREIGN KEY constraint failed')
  expect(db.getScan('scan-a')).toBeNull()
  expect(db.getEntry('scan-a', 'root')).toBeNull()

  db.transaction(() => {
    db.insertScan(scan())
    db.insertEntry(root())
  })
  expect(db.getScan('scan-a')).toEqual(scan())
  expect(db.getEntry('scan-a', 'root')).toEqual(root())
})

function discover(entry: FileEntry): StorageBatchOperation {
  return { type: 'entry', entry: { ...entry, aggregatedSizeBytes: null } }
}

function finalize(entry: FileEntry, bytes: number): StorageBatchOperation {
  return {
    type: 'directory-finalized',
    entry: { ...entry, type: 'directory', sizeBytes: null, aggregatedSizeBytes: bytes }
  }
}

test('commits ordered discoveries and finalizations and preserves exact metadata after reopen', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  const directory = root()
  const empty = { ...directory, id: 'empty', parentId: directory.id, path: join(rootPath, 'empty') }
  const name = "Фото 📁 'quotes' \ud800.txt"
  const known = { ...file(), name, path: join(rootPath, name), sizeBytes: Number.MAX_SAFE_INTEGER }
  const unknown = { ...file('scan-a', 'unknown-size'), sizeBytes: null }

  db.applyBatch('scan-a', [
    discover(directory),
    discover(empty),
    finalize(empty, 0),
    discover(known),
    discover(unknown)
  ])
  expect(db.getEntry('scan-a', directory.id)).toEqual({ ...directory, aggregatedSizeBytes: null })
  expect(db.getEntry('scan-a', empty.id)).toEqual({ ...empty, aggregatedSizeBytes: 0 })
  db.applyBatch('scan-a', [finalize(directory, Number.MAX_SAFE_INTEGER)])
  db.close()

  const reopened = open()
  expect(reopened.getEntry('scan-a', known.id)).toEqual(known)
  expect(reopened.getEntry('scan-a', unknown.id)).toEqual(unknown)
  expect(reopened.getEntry('scan-a', directory.id)).toEqual({
    ...directory,
    aggregatedSizeBytes: Number.MAX_SAFE_INTEGER
  })
  expect(reopened.getEntry('scan-a', empty.id)).toEqual({ ...empty, aggregatedSizeBytes: 0 })
})

test('accepts an empty batch for a running scan and exactly the scanner batch limit', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  db.applyBatch('scan-a', [])
  expect(db.getEntry('scan-a', 'root')).toBeNull()
  const descendants = Array.from({ length: SCANNER_BATCH_SIZE - 1 }, (_, index) =>
    discover({ ...file('scan-a', `file-${index}`), sizeBytes: 0 })
  )
  db.applyBatch('scan-a', [discover(root()), ...descendants])
  expect(db.getEntry('scan-a', `file-${descendants.length - 1}`)?.sizeBytes).toBe(0)
})

test('requires the parent to precede the child and belong to the same scan', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  db.insertScan(scan('scan-b', 'running'))
  db.applyBatch('scan-b', [discover(root('scan-b'))])
  expect(() => db.applyBatch('scan-a', [discover(file()), discover(root())])).toThrow(
    'FOREIGN KEY constraint failed'
  )
  expect(db.getEntry('scan-a', 'file')).toBeNull()
  expect(db.getEntry('scan-a', 'root')).toBeNull()
  expect(db.getEntry('scan-b', 'root')).not.toBeNull()

  db.applyBatch('scan-a', [discover(root()), discover(file())])
  expect(db.getEntry('scan-a', 'file')).toEqual(file())
})

test('rolls back both inserts and finalizations on a later constraint violation', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  db.applyBatch('scan-a', [discover(root())])
  const operations = [discover(file()), finalize(root(), 20)]
  expect(() => db.applyBatch('scan-a', [...operations, discover(root())])).toThrow(
    'UNIQUE constraint failed'
  )
  expect(db.getEntry('scan-a', 'root')).toEqual({ ...root(), aggregatedSizeBytes: null })
  expect(db.getEntry('scan-a', 'file')).toBeNull()

  db.applyBatch('scan-a', operations)
  expect(db.getEntry('scan-a', 'file')).toEqual(file())
  expect(db.getEntry('scan-a', 'root')).toEqual(root())
})

test('rolls back on missing, non-directory, and inconsistent finalization targets', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  db.applyBatch('scan-a', [discover(root()), discover(file())])
  const added = discover(file('scan-a', 'new-file'))
  for (const [target, message] of [
    [finalize({ ...root(), id: 'absent' }, 0), 'Cannot finalize missing entry absent'],
    [finalize(file(), 0), 'Entry file is not a directory'],
    [finalize({ ...root(), modifiedAt: null }, 20), 'differs from its discovery metadata']
  ] as const) {
    expect(() => db.applyBatch('scan-a', [added, target])).toThrow(message)
    expect(db.getEntry('scan-a', 'new-file')).toBeNull()
    expect(db.getEntry('scan-a', 'root')?.aggregatedSizeBytes).toBeNull()
  }
})

test('requires child directories to finalize before their parent and rejects repeated finalization', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  const child = { ...root(), id: 'child', parentId: 'root', path: join(rootPath, 'child') }
  db.applyBatch('scan-a', [discover(root()), discover(child)])
  expect(() => db.applyBatch('scan-a', [finalize(root(), 0), finalize(child, 0)])).toThrow(
    'has an unfinalized child directory'
  )
  expect(db.getEntry('scan-a', child.id)?.aggregatedSizeBytes).toBeNull()

  db.applyBatch('scan-a', [finalize(child, 0), finalize(root(), 0)])
  expect(() => db.applyBatch('scan-a', [finalize(root(), 0)])).toThrow('already finalized')
  expect(() => db.applyBatch('scan-a', [discover(file())])).toThrow(
    'Parent directory root is already finalized'
  )
  expect(db.getEntry('scan-a', 'root')?.aggregatedSizeBytes).toBe(0)
  expect(db.getEntry('scan-a', 'file')).toBeNull()
})

test('requires discoveries to match the scan root and rejects mixed-scan batches', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  expect(() =>
    db.applyBatch('scan-a', [discover({ ...root(), path: join(rootPath, 'other') })])
  ).toThrow('does not match the scan root')
  expect(() => db.applyBatch('scan-a', [discover(root()), discover(file('scan-b'))])).toThrow(
    'belongs to a different scan'
  )
  expect(() => db.applyBatch('scan-a', [discover(root()), finalize(root('scan-b'), 0)])).toThrow(
    'belongs to a different scan'
  )
  expect(db.getEntry('scan-a', 'root')).toBeNull()
})

test.each(['completed', 'cancelled', 'failed'] as const)(
  'rejects batch writes to a %s scan',
  (status) => {
    const db = open()
    db.insertScan(scan('scan-a', status))
    expect(() => db.applyBatch('scan-a', [discover(root())])).toThrow('scan scan-a is not running')
    expect(db.getEntry('scan-a', 'root')).toBeNull()
  }
)

test('requires an existing scan even for an empty batch', () => {
  expect(() => open().applyBatch('scan-a', [])).toThrow('scan scan-a does not exist')
})

test('rejects oversized and malformed batches without retaining an insert', () => {
  const db = open()
  db.insertScan(scan('scan-a', 'running'))
  const discovery = discover(root())
  const oversized = Array.from({ length: SCANNER_BATCH_SIZE + 1 }, () => discovery)
  expect(() => db.applyBatch('scan-a', oversized)).toThrow(
    `at most ${SCANNER_BATCH_SIZE} operations`
  )

  const sparse = new Array<StorageBatchOperation>(2)
  sparse[1] = discovery
  for (const malformed of [
    sparse,
    [discovery, { type: 'other', entry: file() }],
    [{ type: 'entry', entry: root() }],
    [discovery, { type: 'directory-finalized', entry: { ...root(), aggregatedSizeBytes: null } }],
    [discovery, { type: 'directory-finalized', entry: file() }],
    [discovery, discover({ ...file(), sizeBytes: Number.MAX_SAFE_INTEGER + 1 })],
    [discovery, finalize(root(), Number.MAX_SAFE_INTEGER + 1)],
    [discovery, finalize(root(), -1)],
    [discovery, finalize(root(), 0.5)]
  ]) {
    expect(() => Reflect.apply(db.applyBatch, db, ['scan-a', malformed])).toThrow(
      'storage batch operation'
    )
    expect(db.getEntry('scan-a', 'root')).toBeNull()
  }
})
