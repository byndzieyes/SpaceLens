// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import type { CompletedScan } from '../src/main/storage/payloads'
import { parseStorageResponse } from '../src/main/storage/workerProtocol'
import type { FileEntry } from '../src/shared/scan'
import {
  buildingFixture,
  createV1Database,
  legacyEntries,
  legacyScan,
  seedV1Scan
} from './v1-scan-fixture'

let db: ScanDatabase
let directory: string
let path: string
const workingRoot = resolve('scan-history-fixture')

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spacelens-history-'))
  path = join(directory, 'scans.sqlite')
  db = new ScanDatabase(path)
})

afterEach(() => {
  db.close()
  const target = resolve(directory)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('spacelens-history-'))
    throw new Error('Refusing to remove a path outside history fixtures.')
  rmSync(target, { recursive: true, force: true })
})

function publish(
  id: string,
  options: Partial<Pick<CompletedScan, 'rootPath' | 'finishedAt'>> & {
    size?: number
    errorCount?: number
  } = {}
): CompletedScan {
  const {
    rootPath = workingRoot,
    finishedAt = legacyScan.finishedAt,
    size = 0,
    errorCount = 0
  } = options
  const running = { ...buildingFixture(id), rootPath }
  const root: FileEntry = {
    ...legacyEntries.root,
    scanId: id,
    path: rootPath,
    aggregatedSizeBytes: null
  }
  const file: FileEntry = {
    ...legacyEntries.image,
    scanId: id,
    parentId: root.id,
    path: join(rootPath, 'image.png'),
    sizeBytes: size
  }
  db.beginScan(running)
  db.applyBatch(id, [
    { type: 'entry', entry: root },
    { type: 'entry', entry: file },
    {
      type: 'directory-finalized',
      entry: { ...root, type: 'directory', aggregatedSizeBytes: size }
    }
  ])
  return db.publishScan(
    {
      ...running,
      status: 'completed',
      finishedAt,
      summary: { fileCount: 1, directoryCount: 1, totalBytes: size, errorCount }
    },
    root.id
  )
}

test('returns completed metadata only and leaves a valid empty page', () => {
  expect(db.listScanHistory({})).toEqual({
    items: [],
    offset: 0,
    limit: 20,
    totalCount: 0,
    nextOffset: null,
    latestCompletedScanId: null
  })
  const completed = publish('saved', { size: Number.MAX_SAFE_INTEGER, errorCount: 2 })
  db.beginScan(buildingFixture('active'))
  db.insertScan({ ...completed, id: 'unsuccessful', status: 'failed' })
  db.insertScan({ ...completed, id: 'cancelled', status: 'cancelled' })
  const item = { ...completed, durationMs: 900000, incomplete: true, isLatest: true }
  expect(db.listScanHistory({})).toEqual({
    items: [item],
    offset: 0,
    limit: 20,
    totalCount: 1,
    nextOffset: null,
    latestCompletedScanId: completed.id
  })
  expect(db.getScanHistoryMetadata({ scanId: completed.id })).toEqual(item)
  for (const id of ['active', 'unsuccessful', 'cancelled']) {
    expect(() => db.getScanHistoryMetadata({ scanId: id })).toThrow(
      expect.objectContaining({ code: 'SNAPSHOT_UNAVAILABLE' })
    )
  }
  expect(() => db.getScanHistoryMetadata({ scanId: 'missing' })).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
  )
})

test('sorts by publication order and known size with stable newest-first size ties', () => {
  publish('first', { size: 7 })
  publish('second', { size: 3 })
  publish('third', { size: 7, finishedAt: '2026-11-20T13:03:00.000Z' })
  publish('latest', { size: 11, finishedAt: '2026-11-20T13:01:00.000Z' })
  expect(db.listScanHistory({}).items.map(({ id }) => id)).toEqual([
    'latest',
    'third',
    'second',
    'first'
  ])
  expect(db.listScanHistory({ sort: 'oldest' }).items.map(({ id }) => id)).toEqual([
    'first',
    'second',
    'third',
    'latest'
  ])
  expect(db.listScanHistory({ sort: 'size-asc' }).items.map(({ id }) => id)).toEqual([
    'second',
    'third',
    'first',
    'latest'
  ])
  expect(db.listScanHistory({ sort: 'size-desc' }).items.map(({ id }) => id)).toEqual([
    'latest',
    'third',
    'first',
    'second'
  ])
  expect(db.getScanHistoryMetadata({ scanId: 'third' })).toMatchObject({
    isLatest: false,
    durationMs: 180000
  })
})

test('combines literal path filters, stable sorting and pagination with a global Latest ID', () => {
  const root = join(workingRoot, "📁 'Data_%\\part' \ud800")
  publish('first', { rootPath: root, size: 9 })
  publish('matching-search', { rootPath: join(workingRoot, 'Other_%') })
  publish('third', { rootPath: root, size: 1 })
  publish('latest')
  const query = { rootPath: root, rootPathContains: '_%\\part', sort: 'size-asc', limit: 1 }
  expect(db.listScanHistory(query)).toMatchObject({
    items: [{ id: 'third', rootPath: root, isLatest: false }],
    totalCount: 2,
    nextOffset: 1,
    latestCompletedScanId: 'latest'
  })
  expect(db.listScanHistory({ ...query, offset: 1 })).toMatchObject({
    items: [{ id: 'first', rootPath: root }],
    totalCount: 2,
    nextOffset: null
  })
  expect(db.listScanHistory({ rootPath: root.replace('Data', 'data') }).items).toEqual([])
  expect(db.listScanHistory({ rootPathContains: 'data' }).items).toEqual([])
  expect(
    db.listScanHistory({ rootPathContains: "'Data_%\\part' \ud800" }).items.map(({ id }) => id)
  ).toEqual(['third', 'first'])
  expect(db.listScanHistory({ rootPathContains: '_%' }).items.map(({ id }) => id)).toEqual([
    'third',
    'matching-search',
    'first'
  ])
  expect(db.listScanHistory({ rootPath: root, rootPathContains: 'absent' })).toMatchObject({
    items: [],
    totalCount: 0,
    nextOffset: null,
    latestCompletedScanId: 'latest'
  })
})

test('matches root substrings only on UTF-16 code unit boundaries', () => {
  publish('stored', { rootPath: join(workingRoot, '\u0102\u0304') })
  // Bytes 02 03 straddle the two path code units and do not represent U+0203 in the path.
  expect(db.listScanHistory({ rootPathContains: '\u0203' }).items).toEqual([])
  expect(db.listScanHistory({ rootPathContains: '\u0304' }).items.map(({ id }) => id)).toEqual([
    'stored'
  ])
})

test('pages 113 scans without gaps, duplicates, or unbounded results', () => {
  const order = Array.from({ length: 113 }, (_, index) => publish(`scan-${index}`).id)
  const first = db.listScanHistory({ sort: 'oldest' })
  expect(first).toMatchObject({
    offset: 0,
    limit: 20,
    totalCount: 113,
    nextOffset: 20,
    latestCompletedScanId: 'scan-112'
  })
  expect(first.items.map(({ id }) => id)).toEqual(order.slice(0, 20))
  const maximum = db.listScanHistory({ sort: 'oldest', limit: 100 })
  expect(maximum.items).toHaveLength(100)
  const tail = db.listScanHistory({ sort: 'oldest', limit: 100, offset: 100 })
  expect(tail).toMatchObject({ totalCount: 113, nextOffset: null })
  expect([...maximum.items, ...tail.items].map(({ id }) => id)).toEqual(order)
  expect(db.listScanHistory({ offset: Number.MAX_SAFE_INTEGER })).toMatchObject({
    items: [],
    totalCount: 113,
    nextOffset: null,
    latestCompletedScanId: 'scan-112'
  })
})

test('rejects invalid queries and looks up migrated historical metadata after reopen', () => {
  db.close()
  path = join(directory, 'legacy.sqlite')
  {
    using sql = createV1Database(path)
    seedV1Scan(sql, legacyScan, Object.values(legacyEntries))
  }
  db = new ScanDatabase(path)
  const latest = publish('latest')
  db.close()
  db = new ScanDatabase(path)
  db.recoverStorage()
  expect(db.getScanHistoryMetadata({ scanId: legacyScan.id })).toEqual({
    ...legacyScan,
    durationMs: 900000,
    incomplete: true,
    isLatest: false
  })
  expect(db.listScanHistory({}).items.map(({ id }) => id)).toEqual([latest.id, legacyScan.id])
  for (const request of [{ scanId: '../escaped' }, { scanId: latest.id, extra: true }, null])
    expect(() => db.getScanHistoryMetadata(request)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
  for (const query of [{ limit: 101 }, { offset: -1 }, { sort: 'random()' }])
    expect(() => db.listScanHistory(query)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
})

test.each([
  ["finished_at = 'invalid'", 'valid timestamps'],
  ['directory_count = 0', 'Invalid completed scan duration or directory count'],
  ["root_path = x'41'", 'must be a UTF-16 BLOB'],
  ['total_bytes = 9007199254740992', 'outside the non-negative safe integer range']
])('rejects inconsistent stored metadata with %s', (change, message) => {
  publish('old')
  publish('latest')
  using sql = new DatabaseSync(path)
  sql.exec(`UPDATE scans SET ${change} WHERE id = 'old'`)
  expect(() => db.getScanHistoryMetadata({ scanId: 'old' })).toThrow(message)
  expect(() => db.listScanHistory({})).toThrow(message)
  expect(db.getScanHistoryMetadata({ scanId: 'latest' })).toMatchObject({ isLatest: true })
})

test('count, Latest and page use one consistent SQLite read when another connection commits', () => {
  publish('first')
  using writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode = WAL')
  const original = StatementSync.prototype.get
  const read = vi.spyOn(StatementSync.prototype, 'get').mockImplementation(function (
    this: StatementSync,
    ...args: Parameters<StatementSync['get']>
  ) {
    const result = Reflect.apply(original, this, args) as ReturnType<StatementSync['get']>
    if (this.sourceSQL.startsWith('SELECT COUNT(*) AS total_count FROM scans')) {
      writer.exec(`
        BEGIN;
        INSERT INTO scans (id, root_path, status, started_at, finished_at, total_bytes, file_count,
          directory_count, error_count, publication_sequence)
        SELECT 'second', root_path, status, started_at, finished_at, total_bytes, file_count,
          directory_count, error_count, 2 FROM scans WHERE id = 'first';
        UPDATE scan_publication_counter SET last_sequence = 2;
        COMMIT
      `)
    }
    return result
  })
  try {
    expect(db.listScanHistory({})).toMatchObject({
      items: [{ id: 'first', isLatest: true }],
      totalCount: 1,
      latestCompletedScanId: 'first'
    })
  } finally {
    read.mockRestore()
  }
  expect(db.listScanHistory({})).toMatchObject({
    items: [
      { id: 'second', isLatest: true },
      { id: 'first', isLatest: false }
    ],
    totalCount: 2,
    latestCompletedScanId: 'second'
  })
})

test('uses the publication index and scan primary key with plans confined to scan metadata', () => {
  for (let index = 0; index < 30; index++) publish(`scan-${index}`, { size: index % 5 })
  db.close()
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
  db = new ScanDatabase(path)
  db.listScanHistory({})
  db.listScanHistory({ sort: 'oldest' })
  db.listScanHistory({ rootPath: workingRoot })
  db.listScanHistory({ sort: 'size-desc', rootPathContains: 'history' })
  db.getScanHistoryMetadata({ scanId: 'scan-1' })
  const statements = prepare.mock.calls.map(([sql]) => sql)
  const connection = prepare.mock.contexts[0] as DatabaseSync
  prepare.mockRestore()

  const explain = (fragment: string, ...bindings: (number | string | Buffer)[]): string => {
    const sql = statements.find((statement) => statement.includes(fragment))
    if (!sql) throw new Error(`Missing SQL for ${fragment}.`)
    return connection
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...bindings)
      .map(({ detail }) => detail)
      .join('\n')
  }
  for (const order of ['DESC', 'ASC']) {
    const plan = explain(`ORDER BY publication_sequence ${order} LIMIT ? OFFSET ?`, 20, 0)
    expect(plan).toMatch(/SCAN scans USING INDEX scans_by_publication_sequence/)
    expect(plan).not.toMatch(/TEMP B-TREE|entries/i)
  }
  expect(explain('WHERE id = ?', 'scan-1')).toMatch(/SEARCH scans USING INDEX .*\(id=\?\)/)
  expect(
    explain('AND root_path = ? ORDER BY', Buffer.from(workingRoot, 'utf16le').swap16(), 20, 0)
  ).toMatch(/SCAN scans USING INDEX scans_by_publication_sequence/)
  expect(explain('SELECT COUNT(*) AS total_count FROM scans WHERE status')).toMatch(
    /SCAN scans USING (?:COVERING )?INDEX scans_by_publication_sequence/
  )
  const search = Buffer.from('history', 'utf16le').swap16()
  const size = explain('ORDER BY total_bytes DESC', search, 20, 0)
  expect(size).toMatch(/TEMP B-TREE FOR ORDER BY/)
  expect(size).not.toMatch(/entries/i)
})

test('rejects inconsistent or over-limit worker history responses', () => {
  publish('first')
  publish('latest')
  const page = db.listScanHistory({})
  const reply = { requestId: 1, ok: true, result: page }
  expect(parseStorageResponse(reply, 1, 'listScanHistory')).toEqual(reply)
  const older = page.items[1]
  const latest = page.items[0]
  for (const invalid of [
    { ...page, limit: 101 },
    { ...page, latestCompletedScanId: older.id },
    { ...page, items: [latest, latest] },
    { ...page, nextOffset: 2 },
    { ...page, items: [latest, { ...older, publication_sequence: 1n }] },
    { ...page, items: [latest, { ...older, durationMs: -1 }] }
  ]) {
    expect(() => parseStorageResponse({ ...reply, result: invalid }, 1, 'listScanHistory')).toThrow(
      'Invalid response for storage operation listScanHistory.'
    )
  }
})
