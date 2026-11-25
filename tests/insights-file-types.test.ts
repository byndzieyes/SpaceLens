// @vitest-environment node
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SCANNER_BATCH_SIZE } from '../src/main/scanner/workerProtocol'
import { ScanDatabase } from '../src/main/storage/database'
import type {
  BuildingScan,
  CompletedScan,
  StorageBatchOperation
} from '../src/main/storage/payloads'
import type { FileEntry } from '../src/shared/scan'

const rootPath = resolve('analytics-fixture')
const timestamp = '2026-11-21T12:00:00Z'
const pending: BuildingScan = {
  id: 'published',
  rootPath,
  startedAt: timestamp,
  status: 'running',
  finishedAt: null,
  summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
}
const root: FileEntry = {
  scanId: pending.id,
  id: 'root',
  parentId: null,
  name: 'analytics-fixture',
  path: rootPath,
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: null,
  createdAt: null,
  modifiedAt: null
}
let database: ScanDatabase
beforeEach(() => {
  database = new ScanDatabase(':memory:')
})
afterEach(() => database.close())

function entry(name: string, sizeBytes: number | null, id: string): FileEntry {
  return {
    ...root,
    id,
    parentId: root.id,
    name,
    path: join(rootPath, name),
    type: 'file',
    sizeBytes
  }
}

function publish(files: readonly FileEntry[]): CompletedScan {
  const scan: CompletedScan = {
    ...pending,
    status: 'completed',
    finishedAt: timestamp,
    summary: {
      fileCount: files.length,
      directoryCount: 1,
      totalBytes: files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
      errorCount: files.filter(({ sizeBytes }) => sizeBytes === null).length
    }
  }
  database.beginScan(pending)
  const operations: StorageBatchOperation[] = [
    { type: 'entry', entry: root },
    ...files.map((file) => ({ type: 'entry' as const, entry: file })),
    {
      type: 'directory-finalized',
      entry: { ...root, type: 'directory', aggregatedSizeBytes: scan.summary.totalBytes }
    }
  ]
  for (let offset = 0; offset < operations.length; offset += SCANNER_BATCH_SIZE)
    database.applyBatch(scan.id, operations.slice(offset, offset + SCANNER_BATCH_SIZE))
  return database.publishScan(scan, root.id)
}

function page(offset = 0, limit = 100): ReturnType<ScanDatabase['listInsightsExtensions']> {
  return database.listInsightsExtensions({ scanId: pending.id, limit, offset })
}

test('reconciles every group to the published regular-file counts and exact sizes', () => {
  const nested = {
    ...root,
    id: 'nested',
    parentId: root.id,
    name: 'folder.mp4',
    path: join(rootPath, 'folder.mp4'),
    type: 'directory' as const
  }
  const photo = {
    ...entry('nested.JPG', 13, 'nested-image'),
    parentId: nested.id,
    path: join(nested.path, 'nested.JPG')
  }
  const files = [
    entry('front.jpg', 7, 'front'),
    entry('missing.jpg', null, 'missing'),
    entry('blank.jpg', 0, 'blank'),
    entry('movie.mp4', 10, 'movie'),
    entry('sound.mp3', 8, 'sound'),
    entry('document.txt', 6, 'doc'),
    entry('bundle.tar.gz', 5, 'archive'),
    entry('task.ts', 4, 'code'),
    entry('setup.exe', 3, 'app'),
    entry('.gitignore', 2, 'dot'),
    entry('special.what', 1, 'other')
  ]
  const nestedEntry = [photo, ...files]
  // Finalize the nested directory after its actual child, before the root is finalized.
  database.beginScan(pending)
  database.applyBatch(pending.id, [
    { type: 'entry', entry: root },
    { type: 'entry', entry: nested },
    { type: 'entry', entry: photo },
    { type: 'directory-finalized', entry: { ...nested, aggregatedSizeBytes: 13 } },
    ...(['symlink', 'other'] as const).map((type) => ({
      type: 'entry' as const,
      entry: { ...entry(`excluded.${type}.jpg`, null, `excluded-${type}`), type }
    })),
    ...files.map((file) => ({ type: 'entry' as const, entry: file })),
    { type: 'directory-finalized', entry: { ...root, type: 'directory', aggregatedSizeBytes: 59 } }
  ])
  const saved = database.publishScan(
    {
      ...pending,
      status: 'completed',
      finishedAt: timestamp,
      summary: { fileCount: nestedEntry.length, totalBytes: 59, directoryCount: 2, errorCount: 1 }
    },
    root.id
  )
  const totals = {
    fileCount: saved.summary.fileCount,
    knownBytes: saved.summary.totalBytes,
    unknownSizeCount: 1
  }
  expect(database.getInsightsCategories(saved.id)).toEqual({
    scanId: saved.id,
    incomplete: true,
    totals,
    categories: [
      { category: 'images', fileCount: 4, knownBytes: 20, unknownSizeCount: 1 },
      ...(
        [
          ['videos', 10],
          ['audio', 8],
          ['documents', 6],
          ['archives', 5],
          ['code', 4],
          ['applications', 3]
        ] as const
      ).map(([category, knownBytes]) => ({
        category,
        knownBytes,
        fileCount: 1,
        unknownSizeCount: 0
      })),
      { category: 'other', fileCount: 2, knownBytes: 3, unknownSizeCount: 0 }
    ]
  })
  expect(page()).toMatchObject({
    scanId: saved.id,
    incomplete: true,
    totals,
    totalCount: 9,
    nextOffset: null,
    extensions: [
      { extension: 'jpg', knownBytes: 20, fileCount: 4, unknownSizeCount: 1 },
      { extension: 'mp4' },
      { extension: 'mp3' },
      { extension: 'txt' },
      { extension: 'gz' },
      { extension: 'ts' },
      { extension: 'exe' },
      { extension: null, category: 'other', knownBytes: 2 },
      { extension: 'what', category: 'other', knownBytes: 1 }
    ]
  })
  expect(database.getScan(saved.id)).toEqual(saved)
  expect(database.getScanEntry({ scanId: saved.id, entryId: 'missing' }).sizeBytes).toBeNull()
  expect(database.getScanEntry({ scanId: saved.id, entryId: 'blank' }).sizeBytes).toBe(0)
})

test('paginates size ties by file count, then normalized UTF-16 order with null first', () => {
  const names: [string, number][] = [
    ['one.ZZZ', 0],
    ['two.zzz', 0],
    ['z.ÉX', 0],
    ['another.éx', 0],
    ['z.E\u0301X', 0],
    ['.profile', 0],
    ['close.', 0],
    ['x.\ud800', 0],
    ['x.\ud801', 0],
    ['x.\ufffd', 0],
    ['y.📁', 0],
    ['z.AAA', 0],
    ['largest.tar.gz', 3],
    ['x.\uf000', 0]
  ]
  publish(names.map(([name, size], i) => entry(name, size, `file-${i}`)))
  const ordered = [
    'gz',
    null,
    'zzz',
    'éx',
    'aaa',
    'e\u0301x',
    '\ud800',
    '\ud801',
    '📁',
    '\uf000',
    '\ufffd'
  ]
  for (let offset = 0; offset < ordered.length; offset += 3) {
    const result = page(offset, 3)
    expect(result.extensions.map(({ extension }) => extension)).toEqual(
      ordered.slice(offset, offset + 3)
    )
    expect(result.totalCount).toBe(ordered.length)
    expect(result.nextOffset).toBe(offset + 3 < ordered.length ? offset + 3 : null)
    expect(result.totals).toEqual({ fileCount: names.length, knownBytes: 3, unknownSizeCount: 0 })
  }
  expect(page(Number.MAX_SAFE_INTEGER, 1)).toMatchObject({
    extensions: [],
    totalCount: ordered.length,
    nextOffset: null
  })
})

test('bounds extension pages to requested group counts while returning all-group totals', () => {
  publish(Array.from({ length: 121 }, (_, i) => entry(`name.kind-${i}`, i, `file-${i}`)))
  expect(page().extensions).toHaveLength(100)
  expect(page()).toMatchObject({
    totalCount: 121,
    nextOffset: 100,
    totals: { fileCount: 121, knownBytes: 7260 }
  })
  expect(page(100).extensions).toHaveLength(21)
  expect(page(100).nextOffset).toBeNull()
  expect(database.listInsightsExtensions({ scanId: pending.id }).extensions).toHaveLength(50)
  expect(() => page(0, 101)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  expect(() => page(0, -1)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})

test('returns valid zero totals for empty scans and exact bytes at the safe integer limit', () => {
  publish([])
  const empty = {
    scanId: pending.id,
    incomplete: false,
    totals: { fileCount: 0, knownBytes: 0, unknownSizeCount: 0 }
  }
  expect(database.getInsightsCategories(pending.id)).toEqual({ ...empty, categories: [] })
  expect(page()).toEqual({ ...empty, extensions: [], totalCount: 0, nextOffset: null })
  database.close()
  database = new ScanDatabase(':memory:')
  publish([entry('wide.dat', Number.MAX_SAFE_INTEGER, 'max')])
  expect(page().extensions[0].knownBytes).toBe(Number.MAX_SAFE_INTEGER)
  expect(database.getInsightsCategories(pending.id).totals.knownBytes).toBe(Number.MAX_SAFE_INTEGER)
})

test.each([2, 1025])(
  'returns SIZE_OVERFLOW for unsafe and SQLite-overflowing sums of %i entries',
  (count) => {
    publish([])
    // Inject inconsistent data after validation so the aggregate's own guards are exercised.
    database.transaction(() => {
      for (let i = 0; i < count; i++)
        database.insertEntry(
          entry(i % 2 ? 'huge.jpg' : 'huge.mp3', Number.MAX_SAFE_INTEGER, `file-${i}`)
        )
    })
    expect(() => database.getInsightsCategories(pending.id)).toThrow(
      expect.objectContaining({ code: 'SIZE_OVERFLOW' })
    )
    // The overflowing aggregate is also rejected when its group is outside the requested page.
    expect(() => page(10, 1)).toThrow(expect.objectContaining({ code: 'SIZE_OVERFLOW' }))
  }
)

test('rejects totals inconsistent with a stored scan summary', () => {
  publish([])
  database.insertEntry(entry('inconsistent.txt', 1, 'inconsistent'))
  expect(() => database.getInsightsCategories(pending.id)).toThrow('published scan summary')
  expect(() => page()).toThrow('published scan summary')
})
