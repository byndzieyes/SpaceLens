// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import type { CompletedScan } from '../src/main/storage/payloads'
import {
  buildingFixture,
  createV1Database,
  legacyEntries,
  legacyScan,
  seedV1Interrupted,
  seedV1Scan
} from './v1-scan-fixture'

let directory: string
let path: string
const entries = Object.values(legacyEntries)

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spacelens-migration-'))
  path = join(directory, 'scans.sqlite')
})

afterEach(() => {
  const target = resolve(directory)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('spacelens-migration-'))
    throw new Error('Refusing to remove a path outside migration fixtures.')
  rmSync(target, { recursive: true, force: true })
})

function readSchema(sql: DatabaseSync): unknown {
  return sql
    .prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
    .all()
}

function readLegacyRows(sql: DatabaseSync): unknown {
  return {
    scans: sql
      .prepare(
        `
      SELECT id, root_path, status, started_at, finished_at, total_bytes,
             file_count, directory_count, error_count FROM scans ORDER BY id
    `
      )
      .all(),
    entries: sql.prepare('SELECT * FROM entries ORDER BY scan_id, id').all()
  }
}

function readSequences(): unknown {
  using sql = new DatabaseSync(path, { readOnly: true })
  const rows = sql.prepare("SELECT id, publication_sequence FROM scans WHERE status = 'completed'")
  const counter = sql.prepare('SELECT last_sequence FROM scan_publication_counter')
  rows.setReadBigInts(true)
  counter.setReadBigInts(true)
  return { rows: rows.all(), last: counter.get()?.last_sequence }
}

function readyScan(
  db: ScanDatabase,
  id: string,
  finishedAt = legacyScan.finishedAt
): CompletedScan {
  const building = buildingFixture(id)
  db.beginScan(building)
  const root = { ...legacyEntries.root, scanId: id, aggregatedSizeBytes: null }
  db.applyBatch(id, [
    { type: 'entry', entry: root },
    { type: 'directory-finalized', entry: { ...root, type: 'directory', aggregatedSizeBytes: 0 } }
  ])
  return {
    ...building,
    status: 'completed',
    finishedAt,
    summary: { ...building.summary, directoryCount: 1 }
  }
}

test.each([
  { saved: false, interrupted: false },
  { saved: true, interrupted: false },
  { saved: false, interrupted: true },
  { saved: true, interrupted: true }
])('migrates v1 with saved=$saved and interrupted=$interrupted', ({ saved, interrupted }) => {
  let expected: unknown
  {
    using sql = createV1Database(path)
    if (saved) seedV1Scan(sql, legacyScan, entries)
    expected = readLegacyRows(sql)
    if (interrupted) {
      seedV1Interrupted(sql)
      seedV1Interrupted(sql, 'second-interrupted')
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const db = new ScanDatabase(path)
    try {
      db.recoverStorage()
      expect(db.getPublishedScan()).toEqual(saved ? legacyScan : null)
      if (saved) {
        for (const entry of entries) expect(db.getEntry(legacyScan.id, entry.id)).toEqual(entry)
      }
    } finally {
      db.close()
    }
    using sql = new DatabaseSync(path, { readOnly: true })
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    expect(readLegacyRows(sql)).toEqual(expected)
    expect(readSequences()).toEqual({
      last: saved ? 1n : 0n,
      rows: saved ? [{ id: legacyScan.id, publication_sequence: 1n }] : []
    })
  }
})

test('fresh and migrated v2 persist identical schema definitions', () => {
  createV1Database(path).close()
  new ScanDatabase(path).close()
  const freshPath = join(directory, 'fresh.sqlite')
  new ScanDatabase(freshPath).close()
  using migrated = new DatabaseSync(path, { readOnly: true })
  using fresh = new DatabaseSync(freshPath, { readOnly: true })
  expect(readSchema(fresh)).toEqual(readSchema(migrated))
})

test.each(['fresh', 'migrated'])(
  '%s v2 enforces publication and running-scan constraints',
  (source) => {
    if (source === 'migrated') createV1Database(path).close()
    new ScanDatabase(path).close()
    expect(readSequences()).toEqual({ last: 0n, rows: [] })
    using sql = new DatabaseSync(path)
    seedV1Scan(sql, buildingFixture('building'))
    expect(() => seedV1Scan(sql, buildingFixture('second'))).toThrow(/UNIQUE constraint/)
    expect(() => seedV1Scan(sql, legacyScan)).toThrow('Only completed scans')
    expect(() =>
      sql.exec("UPDATE scans SET publication_sequence = 1 WHERE id = 'building'")
    ).toThrow('Only completed scans')
    expect(() =>
      sql.exec(`
    UPDATE scans SET status = 'completed', finished_at = started_at, publication_sequence = 0
  `)
    ).toThrow('CHECK constraint failed')
    sql.exec(
      "UPDATE scans SET status = 'completed', finished_at = started_at, publication_sequence = 1"
    )
    seedV1Scan(sql, buildingFixture('second'))
    expect(() =>
      sql.exec(`
    UPDATE scans SET status = 'completed', finished_at = started_at, publication_sequence = 1
    WHERE id = 'second'
  `)
    ).toThrow('UNIQUE constraint failed: scans.publication_sequence')
    expect(() =>
      sql.exec("UPDATE scans SET publication_sequence = NULL WHERE id = 'building'")
    ).toThrow('Only completed scans')
  }
)

test('allocates in commit order across time ties, clock changes, reopen, and deletion', () => {
  {
    using sql = createV1Database(path)
    seedV1Scan(sql, legacyScan, entries)
  }
  let db = new ScanDatabase(path)
  try {
    const second = readyScan(db, 'second')
    db.publishScan(second, legacyEntries.root.id)
    expect(db.getPublishedScan()).toEqual(second)
    expect(readSequences()).toEqual({
      last: 2n,
      rows: [{ id: second.id, publication_sequence: 2n }]
    })
    db.close()
    db = new ScanDatabase(path)
    db.recoverStorage()
    const third = readyScan(db, 'third', '2026-11-20T13:03:00.000Z')
    db.publishScan(third, legacyEntries.root.id)
    expect(db.getPublishedScan()).toEqual(third)
    expect(readSequences()).toEqual({
      last: 3n,
      rows: [{ id: third.id, publication_sequence: 3n }]
    })
    db.close()
    {
      using sql = new DatabaseSync(path)
      sql.prepare('DELETE FROM scans WHERE id = ?').run(third.id)
    }
    db = new ScanDatabase(path)
    db.recoverStorage()
    expect(db.getPublishedScan()).toBeNull()
    const fourth = readyScan(db, 'fourth')
    db.publishScan(fourth, legacyEntries.root.id)
    expect(readSequences()).toEqual({
      last: 4n,
      rows: [{ id: fourth.id, publication_sequence: 4n }]
    })
  } finally {
    db.close()
  }
})

test('uses the full signed SQLite integer range and preserves the publication on exhaustion', () => {
  const db = new ScanDatabase(path)
  const max = (1n << 63n) - 1n
  try {
    {
      using sql = new DatabaseSync(path)
      sql.prepare('UPDATE scan_publication_counter SET last_sequence = ?').run(max - 1n)
    }
    const saved = readyScan(db, 'last')
    db.publishScan(saved, legacyEntries.root.id)
    const rejected = readyScan(db, 'overflow')
    expect(() => db.publishScan(rejected, legacyEntries.root.id)).toThrow(
      'publication sequence is exhausted'
    )
    expect(db.getPublishedScan()).toEqual(saved)
    expect(db.getScan(rejected.id)?.status).toBe('running')
    expect(readSequences()).toEqual({
      last: max,
      rows: [{ id: saved.id, publication_sequence: max }]
    })
  } finally {
    db.close()
  }
  const reopened = new ScanDatabase(path)
  try {
    reopened.recoverStorage()
    expect(reopened.getPublishedScan()?.id).toBe('last')
    expect(reopened.getScan('overflow')).toBeNull()
    expect(readSequences()).toEqual({
      last: max,
      rows: [{ id: 'last', publication_sequence: max }]
    })
  } finally {
    reopened.close()
  }
})

test.each([
  [
    'missing counter row',
    'DELETE FROM scan_publication_counter',
    'Invalid publication sequence counter'
  ],
  [
    'negative counter',
    'UPDATE scan_publication_counter SET last_sequence = -1',
    'Invalid publication sequence counter'
  ],
  ['counter behind', 'UPDATE scan_publication_counter SET last_sequence = 0', 'counter is behind'],
  [
    'invalid sequence',
    "UPDATE scans SET publication_sequence = 0 WHERE status = 'completed'",
    'Invalid scan publication sequence'
  ],
  [
    'missing sequence',
    "UPDATE scans SET publication_sequence = NULL WHERE status = 'completed'",
    'Invalid scan publication sequence'
  ],
  [
    'sequence on running scan',
    "UPDATE scans SET publication_sequence = 2 WHERE status = 'running'",
    'Invalid scan publication sequence'
  ]
])('fails safely on v2 corruption: %s', (_name, corruption, error) => {
  const db = new ScanDatabase(path)
  try {
    db.publishScan(readyScan(db, 'saved'), legacyEntries.root.id)
    readyScan(db, 'interrupted')
    using sql = new DatabaseSync(path)
    sql.exec('PRAGMA ignore_check_constraints = ON')
    const trigger = sql
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'scans_require_sequence_on_update'")
      .get()?.sql
    if (typeof trigger !== 'string') throw new Error('Missing sequence update trigger.')
    sql.exec('DROP TRIGGER scans_require_sequence_on_update')
    sql.exec(corruption)
    sql.exec(trigger)

    expect(() => db.recoverStorage()).toThrow(error)
    expect(() => new ScanDatabase(path)).toThrow(error)
    expect(sql.prepare('SELECT id FROM scans ORDER BY id').all()).toEqual([
      { id: 'interrupted' },
      { id: 'saved' }
    ])
    expect(sql.prepare('SELECT COUNT(*) AS count FROM entries').get()?.count).toBe(2)
  } finally {
    db.close()
  }
})

test.each(['schema change', 'version update', 'commit'])(
  'rolls back v1 rows, schema, and interrupted-scan cleanup after failure at %s',
  (stage) => {
    let expected: unknown
    let schema: unknown
    {
      using sql = createV1Database(path)
      seedV1Scan(sql, legacyScan, entries)
      seedV1Interrupted(sql)
      expected = readLegacyRows(sql)
      schema = readSchema(sql)
    }
    const exec = DatabaseSync.prototype.exec
    const mock = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (stage === 'commit' && sql === 'COMMIT') throw new Error('Injected migration failure')
      exec.call(this, sql)
      if (
        (stage === 'schema change' && sql.startsWith('ALTER TABLE scans ADD COLUMN')) ||
        (stage === 'version update' && sql === 'PRAGMA user_version = 2')
      )
        throw new Error('Injected migration failure')
    })
    try {
      expect(() => new ScanDatabase(path)).toThrow('Injected migration failure')
    } finally {
      mock.mockRestore()
    }
    {
      using sql = new DatabaseSync(path, { readOnly: true })
      expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      expect(readSchema(sql)).toEqual(schema)
      expect(readLegacyRows(sql)).toEqual(expected)
    }
    const reopened = new ScanDatabase(path)
    try {
      expect(reopened.getPublishedScan()).toEqual(legacyScan)
      expect(reopened.getScan('interrupted')).toBeNull()
    } finally {
      reopened.close()
    }
  }
)

test.each(['bad tree', 'foreign key violation', 'ambiguous publication'])(
  'rejects v1 with %s before removing interrupted scans',
  (problem) => {
    {
      using sql = createV1Database(path)
      seedV1Scan(sql, legacyScan, entries)
      seedV1Interrupted(sql)
      if (problem === 'bad tree') sql.exec("UPDATE scans SET total_bytes = 99 WHERE id = 'legacy'")
      if (problem === 'foreign key violation') {
        sql.exec(
          "PRAGMA foreign_keys = OFF; DELETE FROM entries WHERE scan_id = 'interrupted' AND id = 'folder'"
        )
      }
      if (problem === 'ambiguous publication') seedV1Scan(sql, { ...legacyScan, id: 'ambiguous' })
    }
    const reason = {
      'bad tree': 'root is unfinished or its total differs',
      'foreign key violation': 'invalid scan or entry references',
      'ambiguous publication': 'more than one completed scan'
    }[problem]!
    expect(() => new ScanDatabase(path)).toThrow(reason)
    using sql = new DatabaseSync(path, { readOnly: true })
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(sql.prepare("SELECT id FROM scans WHERE status = 'running'").all()).toEqual([
      { id: 'interrupted' }
    ])
    expect(
      sql.prepare("SELECT id FROM entries WHERE scan_id = 'legacy' ORDER BY id").all()
    ).toEqual(['folder', 'image', 'root', 'unknown'].map((id) => ({ id })))
  }
)
