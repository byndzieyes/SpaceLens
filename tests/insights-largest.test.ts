// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import type { BuildingScan } from '../src/main/storage/payloads'
import type { InsightsRankedEntry } from '../src/shared/insights'
import type { FileEntry } from '../src/shared/scan'

const rootPath = resolve('ranked-fixture')
const time = '2026-11-21T12:00:00Z'
const pending: BuildingScan = {
  id: 'published',
  rootPath,
  status: 'running',
  startedAt: time,
  finishedAt: null,
  summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
}
const root: FileEntry = {
  scanId: pending.id,
  id: 'root',
  parentId: null,
  name: basename(rootPath),
  path: rootPath,
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 0,
  createdAt: null,
  modifiedAt: null
}
let scratch: string
let databasePath: string
let db: ScanDatabase

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'spacelens-largest-'))
  databasePath = join(scratch, 'scans.sqlite')
  db = new ScanDatabase(databasePath)
})
afterEach(() => {
  db.close()
  if (
    dirname(resolve(scratch)) !== resolve(tmpdir()) ||
    !basename(scratch).startsWith('spacelens-largest-')
  ) {
    throw new Error('Refusing to remove paths outside ranking fixtures.')
  }
  rmSync(scratch, { recursive: true, force: true })
})

function directory(id: string, bytes: number, parent = root, name = id): FileEntry {
  return {
    ...root,
    id,
    name,
    path: join(parent.path, name),
    parentId: parent.id,
    aggregatedSizeBytes: bytes
  }
}

function file(id: string, bytes: number | null, parent = root, name = id): FileEntry {
  return {
    ...root,
    id,
    name,
    path: join(parent.path, name),
    parentId: parent.id,
    type: 'file',
    sizeBytes: bytes,
    aggregatedSizeBytes: null
  }
}

function publish(entries: readonly FileEntry[]): void {
  const files = entries.filter(({ type }) => type === 'file')
  const totalBytes = files.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0)
  db.beginScan(pending)
  db.transaction(() => {
    db.insertEntry({ ...root, aggregatedSizeBytes: totalBytes })
    for (const entry of entries) db.insertEntry(entry)
  })
  db.publishScan(
    {
      ...pending,
      status: 'completed',
      finishedAt: time,
      summary: {
        fileCount: files.length,
        totalBytes,
        directoryCount: entries.filter(({ type }) => type === 'directory').length + 1,
        errorCount: files.filter(({ sizeBytes }) => sizeBytes === null).length
      }
    },
    root.id
  )
}

function page(
  type: InsightsRankedEntry['type'],
  offset?: number,
  limit?: number
): ReturnType<ScanDatabase['listInsightsLargest']> {
  return db.listInsightsLargest(
    {
      scanId: pending.id,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit })
    },
    type
  )
}

function updateSize(
  column: 'size_bytes' | 'aggregated_size_bytes',
  id: string,
  bytes: bigint | null
): void {
  const injected = new DatabaseSync(databasePath)
  try {
    injected
      .prepare(`UPDATE entries SET ${column} = ? WHERE scan_id = ? AND id = ?`)
      .run(bytes, pending.id, id)
  } finally {
    injected.close()
  }
}

test.each(['file', 'directory'] as const)(
  'returns an empty %s ranking for a published root alone',
  (type) => {
    publish([])
    expect(page(type)).toEqual({
      scanId: pending.id,
      incomplete: false,
      entries: [],
      offset: 0,
      limit: 10,
      totalCount: 0,
      nextOffset: null
    })
  }
)

test('returns one zero-byte file and directory with the existing Explorer identities', () => {
  const child = directory('child', 0)
  const nestedFile = file('page', 0, child, '資料.txt')
  publish([child, nestedFile])
  for (const type of ['file', 'directory'] as const) {
    const result = page(type)
    const source = type === 'file' ? nestedFile : child
    expect(result).toMatchObject({ totalCount: 1, nextOffset: null })
    expect(result.entries).toEqual([
      {
        type,
        bytes: 0,
        id: source.id,
        scanId: pending.id,
        parentId: source.parentId,
        name: source.name,
        path: source.path
      }
    ])
    const [{ scanId, id }] = result.entries
    expect(db.getScanEntry({ scanId, entryId: id })).toEqual(source)
  }
})

test.each([5, 20, 32])(
  'selects, bounds and paginates the global rankings from %i eligible entries',
  (count) => {
    const entries = Array.from({ length: count }, (_, i) => {
      const bytes = i % 3 === 0 ? i * 9 : i % 4
      const folder = directory(`folder-${i}`, bytes)
      return [folder, file(`file-${i}`, bytes, folder)]
    }).flat()
    publish(entries)
    for (const type of ['file', 'directory'] as const) {
      const bytes = (entry: FileEntry): number =>
        (type === 'file' ? entry.sizeBytes : entry.aggregatedSizeBytes) ?? -1
      const byText = (left: string, right: string): number =>
        left < right ? -1 : left > right ? 1 : 0
      const expected = entries
        .filter((entry) => entry.type === type)
        .toSorted(
          (left, right) =>
            bytes(right) - bytes(left) || byText(left.path, right.path) || byText(left.id, right.id)
        )
        .slice(0, 20)
        .map(({ id }) => id)
      const first = page(type)
      const second = page(type, 10)
      expect(first.entries.map(({ id }) => id)).toEqual(expected.slice(0, 10))
      expect(second.entries.map(({ id }) => id)).toEqual(expected.slice(10))
      expect(first.nextOffset).toBe(count > 10 ? 10 : null)
      expect(second).toMatchObject({
        offset: 10,
        limit: 10,
        nextOffset: null,
        totalCount: expected.length
      })
      expect(page(type, 0, 20).entries.map(({ id }) => id)).toEqual(expected)
      expect(page(type, Number.MAX_SAFE_INTEGER, 20)).toMatchObject({
        entries: [],
        offset: Number.MAX_SAFE_INTEGER,
        totalCount: expected.length,
        nextOffset: null
      })
      expect(page(type)).toEqual(first)
    }
  }
)

test('ranks deep files and overlapping directory aggregates and excludes symlinks and the root', () => {
  const parent = directory('parent', 84)
  const child = directory('child', 80, parent)
  const deep = directory('deep', 80, child)
  const link = { ...file('link', null, deep), type: 'symlink' as const }
  const other = { ...file('other', null, deep), type: 'other' as const }
  publish([
    parent,
    child,
    deep,
    file('winner', 80, deep),
    file('small', 4, parent),
    file('middle', 5),
    link,
    other
  ])
  expect(page('file').entries.map(({ id, bytes }) => [id, bytes])).toEqual([
    ['winner', 80],
    ['middle', 5],
    ['small', 4]
  ])
  expect(page('directory').entries.map(({ id, bytes }) => [id, bytes])).toEqual([
    ['parent', 84],
    ['child', 80],
    ['deep', 80]
  ])
})

test('uses original UTF-16 path order, binary IDs on ties and null sizes after zero', () => {
  const empty = directory('empty', 0)
  const missing = directory('available-later', 0)
  publish([
    missing,
    empty,
    file('Z', 8, root, '📁.txt'),
    file('a', 8, root, '📁.txt'),
    file('bmp', 8, root, '\ue000.txt'),
    file('unpaired', 8, root, '\ud800.txt'),
    file('zero', 0, root, 'A-first'),
    file('unknown', null, empty, 'unknown')
  ])
  // Real publications finalize directories; inject unavailable metadata to verify ranking behavior.
  updateSize('aggregated_size_bytes', missing.id, null)
  expect(page('directory')).toMatchObject({
    incomplete: true,
    entries: [
      { id: empty.id, bytes: 0 },
      { id: missing.id, bytes: null }
    ]
  })
  expect(page('file', 0, 3)).toMatchObject({
    incomplete: true,
    nextOffset: 3,
    entries: [
      { id: 'unpaired', name: '\ud800.txt', path: join(rootPath, '\ud800.txt') },
      { id: 'Z', name: '📁.txt' },
      { id: 'a', name: '📁.txt' }
    ]
  })
  expect(page('file', 3, 3)).toMatchObject({
    nextOffset: null,
    entries: [
      { id: 'bmp', bytes: 8 },
      { id: 'zero', bytes: 0 },
      { id: 'unknown', bytes: null }
    ]
  })
})

test('keeps exact safe sizes and reports structured overflow even on a past-end page', () => {
  const max = directory('max', Number.MAX_SAFE_INTEGER)
  publish([max, file('largest', Number.MAX_SAFE_INTEGER, max)])
  expect(page('file').entries[0].bytes).toBe(Number.MAX_SAFE_INTEGER)
  expect(page('directory').entries[0].bytes).toBe(Number.MAX_SAFE_INTEGER)
  // Reopen to clear cached analytics, then deliberately corrupt the validated fixture.
  db.close()
  db = new ScanDatabase(databasePath)
  db.recoverStorage()
  updateSize('size_bytes', 'largest', 9_223_372_036_854_775_807n)
  updateSize('aggregated_size_bytes', max.id, 9_007_199_254_740_992n)
  expect(() => page('file', 20)).toThrow(expect.objectContaining({ code: 'SIZE_OVERFLOW' }))
  expect(() => page('directory')).toThrow(expect.objectContaining({ code: 'SIZE_OVERFLOW' }))
})

test('rejects invalid offsets and limits at the database boundary', () => {
  publish([])
  for (const request of [
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 21 }
  ]) {
    expect(() => db.listInsightsLargest({ scanId: pending.id, ...request }, 'file')).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
  }
})
