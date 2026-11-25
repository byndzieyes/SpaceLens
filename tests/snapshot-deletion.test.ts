// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import type { CompletedScan } from '../src/main/storage/payloads'
import { buildingFixture, legacyEntries, legacyScan } from './v1-scan-fixture'

let directory: string
let path: string
let db: ScanDatabase

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spacelens-deletion-'))
  path = join(directory, 'scans.sqlite')
  db = new ScanDatabase(path)
})

afterEach(() => {
  db.close()
  const target = resolve(directory)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('spacelens-deletion-'))
    throw new Error('Refusing to remove a path outside deletion fixtures.')
  rmSync(target, { recursive: true, force: true })
})

function publish(id: string, finishedAt = legacyScan.finishedAt): CompletedScan {
  const pending = buildingFixture(id)
  const { root, folder, image, unknown } = legacyEntries
  db.beginScan(pending)
  db.applyBatch(id, [
    { type: 'entry', entry: { ...root, scanId: id, aggregatedSizeBytes: null } },
    { type: 'entry', entry: { ...folder, scanId: id, aggregatedSizeBytes: null } },
    { type: 'entry', entry: { ...image, scanId: id } },
    { type: 'entry', entry: { ...unknown, scanId: id } },
    {
      type: 'directory-finalized',
      entry: { ...folder, scanId: id, type: 'directory', aggregatedSizeBytes: 25 }
    },
    {
      type: 'directory-finalized',
      entry: { ...root, scanId: id, type: 'directory', aggregatedSizeBytes: 25 }
    }
  ])
  return db.publishScan({ ...legacyScan, id, finishedAt }, root.id)
}

test('deletes an older tree and preserves Latest, its cache, and an unrelated building scan', () => {
  const older = publish('older')
  const latest = publish('latest')
  const pending = buildingFixture('building')
  db.beginScan(pending)
  const buildingEntry = { ...legacyEntries.root, scanId: pending.id, aggregatedSizeBytes: null }
  db.applyBatch(pending.id, [{ type: 'entry', entry: buildingEntry }])
  const warm = db.getInsightsCategories(latest.id)
  expect(db.deleteSnapshot({ scanId: older.id })).toEqual({
    scanId: older.id,
    latestCompletedScanId: latest.id,
    latestCompleted: latest
  })
  expect(db.getScan(older.id)).toBeNull()
  for (const entry of Object.values(legacyEntries)) {
    expect(db.getEntry(older.id, entry.id)).toBeNull()
    expect(db.getEntry(latest.id, entry.id)).toEqual({ ...entry, scanId: latest.id })
  }
  expect(db.getScan(pending.id)).toEqual(pending)
  expect(db.getEntry(pending.id, buildingEntry.id)).toEqual(buildingEntry)
  expect(db.getInsightsCategories(latest.id)).toBe(warm)
  expect(db.listScanHistory({})).toMatchObject({
    items: [{ id: latest.id, isLatest: true }],
    totalCount: 1,
    latestCompletedScanId: latest.id
  })
  expect(() => db.getScanHistoryMetadata({ scanId: older.id })).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
  )
  expect(() => db.deleteSnapshot({ scanId: older.id })).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
  )
})

test('chooses replacement Latest in sequence order and preserves the high-water mark through empty history and reopen', () => {
  const first = publish('first')
  const second = publish('second')
  const third = publish('third', '2026-11-20T13:05:00.000Z')
  expect(db.getInsightsCategories(third.id).scanId).toBe(third.id)
  expect(db.deleteSnapshot({ scanId: third.id }).latestCompleted).toEqual(second)
  expect(db.getInsightsCategories(second.id).scanId).toBe(second.id)
  expect(db.getInsightsCategories(first.id).scanId).toBe(first.id)
  expect(db.deleteSnapshot({ scanId: second.id }).latestCompleted).toEqual(first)
  expect(db.deleteSnapshot({ scanId: first.id })).toEqual({
    scanId: first.id,
    latestCompleted: null,
    latestCompletedScanId: null
  })
  expect(() => db.getInsightsCategories(first.id)).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
  )
  expect(db.getScanSnapshot()).toEqual({ snapshot: null, unavailable: null })
  expect(db.listScanHistory({})).toMatchObject({
    items: [],
    totalCount: 0,
    latestCompletedScanId: null
  })
  db.close()
  db = new ScanDatabase(path)
  db.recoverStorage()
  expect(db.getPublishedScan()).toBeNull()
  const replacement = publish('replacement')
  expect(db.getPublishedScan()).toEqual(replacement)
  using observer = new DatabaseSync(path, { readOnly: true })
  expect(
    observer.prepare('SELECT publication_sequence FROM scans').get()?.publication_sequence
  ).toBe(4)
})

test('rejects invalid, missing, running, and invalid persisted snapshots', () => {
  const saved = publish('saved')
  const building = buildingFixture('building')
  db.beginScan(building)
  for (const [request, code] of [
    [{ scanId: '../path' }, 'INVALID_REQUEST'],
    [{ scanId: saved.id, rootPath: saved.rootPath }, 'INVALID_REQUEST'],
    [{ scanId: 'missing' }, 'SNAPSHOT_EXPIRED'],
    [{ scanId: building.id }, 'SNAPSHOT_UNAVAILABLE']
  ] as const) {
    expect(() => db.deleteSnapshot(request)).toThrow(expect.objectContaining({ code }))
  }
  using observer = new DatabaseSync(path)
  observer.prepare("UPDATE scans SET finished_at = 'bad' WHERE id = ?").run(saved.id)
  expect(() => db.deleteSnapshot({ scanId: saved.id })).toThrow('valid timestamps')
  expect(observer.prepare('SELECT COUNT(*) AS count FROM entries').get()?.count).toBe(4)
})

test('rolls back a completed scan and its cascading entry deletion when commit fails', () => {
  const first = publish('first')
  const latest = publish('latest')
  const warm = db.getInsightsCategories(latest.id)
  const exec = DatabaseSync.prototype.exec
  const commit = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    if (sql === 'COMMIT') {
      expect(this.prepare('SELECT id FROM scans WHERE id = ?').get(latest.id)).toBeUndefined()
      expect(
        this.prepare('SELECT COUNT(*) AS count FROM entries WHERE scan_id = ?').get(latest.id)
          ?.count
      ).toBe(0)
      throw new Error('Injected deletion commit failure.')
    }
    exec.call(this, sql)
  })
  try {
    expect(() => db.deleteSnapshot({ scanId: latest.id })).toThrow(
      'Injected deletion commit failure.'
    )
  } finally {
    commit.mockRestore()
  }
  expect(db.getPublishedScan()).toEqual(latest)
  expect(db.getScan(first.id)).toEqual(first)
  expect(db.getInsightsCategories(latest.id)).toBe(warm)
  for (const entry of Object.values(legacyEntries)) {
    expect(db.getEntry(latest.id, entry.id)).toEqual({ ...entry, scanId: latest.id })
  }
  using observer = new DatabaseSync(path, { readOnly: true })
  expect(
    observer.prepare('SELECT last_sequence FROM scan_publication_counter').get()?.last_sequence
  ).toBe(2)
})
