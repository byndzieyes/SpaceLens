// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync, StatementSync, type SQLOutputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  AnalyticsCache,
  ANALYTICS_CACHE_BYTES,
  MAX_CACHED_EXTENSION_GROUPS
} from '../src/main/storage/analyticsCache'
import { ScanDatabase } from '../src/main/storage/database'
import type { BuildingScan, CompletedScan } from '../src/main/storage/payloads'
import type { InsightsRankedEntry, InsightsRankingPage } from '../src/shared/insights'
import type { FileEntry } from '../src/shared/scan'

const time = '2026-11-21T12:00:00Z'
const rootPath = resolve('cache-fixture')
let db: ScanDatabase
let scratch: string
let databasePath: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'spacelens-cache-test-'))
  databasePath = join(scratch, 'scans.sqlite')
  db = new ScanDatabase(databasePath)
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  if (
    dirname(resolve(scratch)) !== resolve(tmpdir()) ||
    !basename(scratch).startsWith('spacelens-cache-test-')
  )
    throw new Error('Invalid cache fixture directory.')
  rmSync(scratch, { recursive: true, force: true })
})

function building(id: string): BuildingScan {
  return {
    id,
    rootPath,
    status: 'running',
    startedAt: time,
    finishedAt: null,
    summary: { totalBytes: 0, directoryCount: 0, fileCount: 0, errorCount: 0 }
  }
}

function seed(
  id: string,
  sizes: readonly (number | null)[],
  names = sizes.map((_, index) => `name-${index}.ext-${index}`)
): CompletedScan {
  const scan = building(id)
  db.beginScan(scan)
  const sum = (values: readonly (number | null)[]): number =>
    values.reduce<number>((total, value) => total + (value ?? 0), 0)
  const middle = Math.floor(sizes.length / 2)
  const root: FileEntry = {
    scanId: id,
    id: 'root',
    type: 'directory',
    parentId: null,
    name: 'root',
    path: rootPath,
    sizeBytes: null,
    aggregatedSizeBytes: sum(sizes),
    createdAt: null,
    modifiedAt: null
  }
  db.transaction(() => {
    db.insertEntry(root)
    for (const [index, bytes] of [
      sum(sizes.slice(0, middle)),
      sum(sizes.slice(middle))
    ].entries()) {
      const folder = `folder-${index}`
      db.insertEntry({
        ...root,
        id: folder,
        name: folder,
        path: join(root.path, folder),
        parentId: root.id,
        aggregatedSizeBytes: bytes
      })
    }
    sizes.forEach((sizeBytes, index) => {
      const parentId = index < middle ? 'folder-0' : 'folder-1'
      db.insertEntry({
        ...root,
        id: `file-${index}`,
        name: names[index],
        path: join(root.path, parentId, names[index]),
        parentId,
        type: 'file',
        sizeBytes,
        aggregatedSizeBytes: null
      })
    })
  })
  return db.publishScan(
    {
      ...scan,
      status: 'completed',
      finishedAt: time,
      summary: {
        totalBytes: sum(sizes),
        directoryCount: 3,
        fileCount: sizes.length,
        errorCount: sizes.filter((size) => size === null).length
      }
    },
    root.id
  )
}

function measureSql(): { kinds: string[]; extensionRows: number[] } {
  const kinds: string[] = []
  const extensionRows: number[] = []
  const all = StatementSync.prototype.all
  vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (
    this: StatementSync,
    ...args
  ) {
    const sql = this.sourceSQL
    const rows = Reflect.apply(all, this, args) as Record<string, SQLOutputValue>[]
    if (sql.includes('spacelens_file_category(name)')) kinds.push('categories')
    if (sql.includes('spacelens_file_extension(name)')) {
      kinds.push('extensions')
      extensionRows.push(rows.length)
    }
    if (sql.includes('COUNT(size_bytes) AS known_count')) kinds.push('sizeDistribution')
    if (sql.includes('WITH ranked AS MATERIALIZED'))
      kinds.push(sql.includes("type = 'directory'") ? 'directories' : 'files')
    return rows
  })
  return { kinds, extensionRows }
}

test('reuses all computed sources, full ranking pages, and the observation result in one publication', () => {
  const { id } = seed('saved', [...Array(30).fill(5), null])
  const { kinds, extensionRows } = measureSql()
  const first = db.listInsightsExtensions({ scanId: id, limit: 10 })
  const second = db.listInsightsExtensions({ scanId: id, offset: 10, limit: 10 })
  const rest = db.listInsightsExtensions({ scanId: id, offset: 20, limit: 100 })
  expect(
    [...first.extensions, ...second.extensions, ...rest.extensions].map(
      ({ extension }) => extension
    )
  ).toEqual([...Array.from({ length: 30 }, (_, i) => `ext-${i}`).sort(), 'ext-30'])
  expect(first).toMatchObject({ nextOffset: 10, totalCount: 31 })
  expect(second.nextOffset).toBe(20)
  expect(rest.nextOffset).toBeNull()
  expect(extensionRows).toEqual([31])

  const result = db.getInsightsObservations(id)
  expect(result).toMatchObject({
    scanId: id,
    observations: [
      { type: 'incompleteScan' },
      { type: 'dominantCategory' },
      { type: 'directoryConcentration' },
      { type: 'smallFilesPrevalence' }
    ]
  })
  expect(db.getInsightsObservations(id)).toBe(result)
  expect(db.getInsightsSizeDistribution(id).knownSizeCount).toBe(30)
  expect(db.getInsightsCategories(id).totals.fileCount).toBe(31)
  expect(db.listInsightsLargest({ scanId: id, offset: 0, limit: 10 }, 'file').nextOffset).toBe(10)
  expect(
    db.listInsightsLargest({ scanId: id, offset: 10, limit: 10 }, 'file').nextOffset
  ).toBeNull()
  expect(
    db.listInsightsLargest({ scanId: id, offset: 1, limit: 20 }, 'directory').entries
  ).toHaveLength(1)
  expect(kinds).toEqual(['extensions', 'sizeDistribution', 'categories', 'files', 'directories'])
})

test('keeps warm selected analytics during building, failed writes, publication, and unrelated deletion', () => {
  const prev = seed('previous', Array(20).fill(0))
  const executed = measureSql().kinds
  const previous = db.getInsightsObservations(prev.id)
  db.beginScan(building('pending'))
  expect(() => db.getInsightsObservations('pending')).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_UNAVAILABLE' })
  )
  expect(() =>
    db.publishScan({ ...building('pending'), status: 'completed', finishedAt: time }, 'root')
  ).toThrow()
  expect(db.getInsightsObservations(prev.id)).toBe(previous)
  db.discardBuildingScan('pending')
  expect(db.getInsightsObservations(prev.id)).toBe(previous)
  expect(executed).toEqual(['sizeDistribution'])
  const next = seed('replacement', [0, null])
  expect(db.getScan(prev.id)).toEqual(prev)
  expect(db.getInsightsObservations(prev.id)).toBe(previous)
  const newer = seed('newer', [])
  db.deleteSnapshot({ scanId: next.id })
  db.deleteSnapshot({ scanId: newer.id })
  expect(db.getInsightsObservations(prev.id)).toBe(previous)
  expect(executed).toEqual(['sizeDistribution'])
  const current = seed('current', [0, null])
  const replacement = db.getInsightsObservations(current.id)
  expect(replacement).toMatchObject({
    scanId: current.id,
    observations: [{ type: 'incompleteScan' }]
  })
  expect(executed).toEqual(['sizeDistribution', 'sizeDistribution'])
  db.close()
  db = new ScanDatabase(databasePath)
  db.recoverStorage()
  expect(db.getScan(prev.id)).toEqual(prev)
  expect(db.getInsightsObservations(current.id)).toEqual(replacement)
  expect(executed).toEqual(['sizeDistribution', 'sizeDistribution', 'sizeDistribution'])
})

test('scopes every aggregate to one retained scan, reuses Explorer validation, and invalidates the deleted cached ID', () => {
  const archive = seed('archive', [50, null, 100], ['photo.jpg', 'notes.txt', 'clip.mp4'])
  const older = seed('older', [9, 8], ['readme.md', 'poster.png'])
  const latest = seed('latest', [])
  const get = StatementSync.prototype.get
  const validated: unknown[] = []
  vi.spyOn(StatementSync.prototype, 'get').mockImplementation(function (
    this: StatementSync,
    ...args: Parameters<StatementSync['get']>
  ): Record<string, SQLOutputValue> | undefined {
    if (this.sourceSQL.includes('WITH RECURSIVE reachable')) validated.push(args[0])
    return Reflect.apply(get, this, args) as ReturnType<StatementSync['get']>
  })

  expect(db.getInsightsCategories(latest.id)).toMatchObject({ scanId: latest.id, categories: [] })
  db.openSavedSnapshot({ scanId: archive.id })
  expect(db.requireValidatedScan(archive.id)).toEqual(archive)
  const categories = db.getInsightsCategories(archive.id)
  expect(categories).toMatchObject({
    scanId: archive.id,
    incomplete: true,
    totals: { fileCount: 3, knownBytes: 150, unknownSizeCount: 1 }
  })
  expect(db.getInsightsCategories(archive.id)).toBe(categories)
  expect(db.listInsightsExtensions({ scanId: archive.id, offset: 1, limit: 1 })).toMatchObject({
    scanId: archive.id,
    totalCount: 3,
    nextOffset: 2,
    extensions: [{ extension: 'jpg' }]
  })
  expect(db.listInsightsLargest({ scanId: archive.id }, 'file')).toMatchObject({
    scanId: archive.id,
    entries: [
      { id: 'file-2', name: 'clip.mp4', bytes: 100 },
      { id: 'file-0', name: 'photo.jpg', bytes: 50 },
      { id: 'file-1', name: 'notes.txt', bytes: null }
    ]
  })
  expect(db.listInsightsLargest({ scanId: archive.id }, 'directory').entries[0]).toMatchObject({
    id: 'folder-1',
    scanId: archive.id,
    bytes: 100
  })
  expect(db.getInsightsSizeDistribution(archive.id)).toMatchObject({
    scanId: archive.id,
    knownSizeCount: 2
  })
  expect(db.getInsightsObservations(archive.id)).toMatchObject({
    scanId: archive.id,
    observations: [{ type: 'incompleteScan' }]
  })
  expect(validated).toHaveLength(1)

  expect(db.listInsightsLargest({ scanId: older.id }, 'file').entries[0]).toMatchObject({
    id: 'file-0',
    scanId: older.id,
    name: 'readme.md',
    bytes: 9
  })
  expect(db.getInsightsCategories(archive.id)).toEqual(categories)
  expect(db.getInsightsCategories(archive.id)).not.toBe(categories)
  expect(validated).toHaveLength(2)
  db.deleteSnapshot({ scanId: archive.id })
  expect(() => db.getInsightsCategories(archive.id)).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
  )
  seed(archive.id, [4], ['new.txt'])
  expect(db.getInsightsCategories(archive.id)).toMatchObject({
    scanId: archive.id,
    totals: { fileCount: 1, knownBytes: 4, unknownSizeCount: 0 }
  })
  expect(db.getInsightsCategories(latest.id)).toMatchObject({ scanId: latest.id, categories: [] })
})

test('rejects corrupt retained analytics independently of Latest', () => {
  const broken = seed('broken', [20])
  const latest = seed('latest', [88])
  using sqlite = new DatabaseSync(databasePath)
  sqlite
    .prepare("UPDATE entries SET size_bytes = 21 WHERE scan_id = ? AND id = 'file-0'")
    .run(broken.id)
  expect(() => db.getInsightsSizeDistribution(broken.id)).toThrow(
    expect.objectContaining({
      code: 'SNAPSHOT_UNAVAILABLE',
      message: 'This saved snapshot failed integrity checks.'
    })
  )
  expect(db.getInsightsSizeDistribution(latest.id)).toMatchObject({
    scanId: latest.id,
    totals: { knownBytes: 88 }
  })
  expect(db.getScan(broken.id)).toEqual(broken)
})

test('falls back to exact bounded SQL pages when more extension groups exist than the cache allows', () => {
  const count = MAX_CACHED_EXTENSION_GROUPS + 3
  const { id } = seed(
    'wide',
    Array.from({ length: count }, (_, index) => index + 1)
  )
  const { extensionRows } = measureSql()
  const first = db.listInsightsExtensions({ scanId: id, limit: 2 })
  const last = db.listInsightsExtensions({ scanId: id, offset: count - 1, limit: 2 })
  expect(first).toMatchObject({
    totalCount: count,
    nextOffset: 2,
    extensions: [
      { extension: `ext-${count - 1}`, knownBytes: count },
      { extension: `ext-${count - 2}`, knownBytes: count - 1 }
    ]
  })
  expect(last).toMatchObject({
    totalCount: count,
    nextOffset: null,
    extensions: [{ extension: 'ext-0', knownBytes: 1 }]
  })
  expect(
    db.listInsightsExtensions({ scanId: id, offset: Number.MAX_SAFE_INTEGER, limit: 2 })
  ).toMatchObject({ totalCount: count, nextOffset: null, extensions: [] })
  expect(extensionRows).toEqual([2, 1, 1]) // The empty page still reads one metadata row.
})

test('checks extension string weight in SQLite before bringing groups into JavaScript', () => {
  const suffix = 'x'.repeat(ANALYTICS_CACHE_BYTES / 2)
  const { id } = seed('long-name', [10, 1], ['short.txt', `long.${suffix}`])
  const { extensionRows } = measureSql()
  expect(db.listInsightsExtensions({ scanId: id, limit: 1 })).toMatchObject({
    extensions: [{ extension: 'txt' }],
    totalCount: 2,
    nextOffset: 1
  })
  expect(db.listInsightsExtensions({ scanId: id, offset: 1, limit: 1 })).toMatchObject({
    extensions: [{ extension: suffix }],
    totalCount: 2,
    nextOffset: null
  })
  expect(extensionRows).toEqual([1, 1])
})

function ranked(type: InsightsRankedEntry['type']): InsightsRankingPage {
  return {
    scanId: 'saved',
    incomplete: false,
    totalCount: 1,
    offset: 0,
    limit: 20,
    nextOffset: null,
    entries: [
      {
        scanId: 'saved',
        id: 'entry',
        parentId: 'root',
        type,
        bytes: 1,
        name: 'item',
        path: 'p'.repeat(100_000)
      }
    ]
  }
}

test('evicts the least recently used aggregate and rejects an oversized value or mismatched scan', () => {
  const cache = new AnalyticsCache()
  cache.useScan('saved')
  const files = ranked('file')
  cache.set('largestFiles', files)
  cache.set('largestDirectories', ranked('directory'))
  expect(cache.get('largestFiles')).toBe(files)
  const totals = { fileCount: 1, knownBytes: 1, unknownSizeCount: 0 }
  const extension = {
    scanId: 'saved',
    incomplete: false,
    totals,
    totalCount: 1,
    extensions: [{ category: 'other' as const, extension: 'x'.repeat(70_000), ...totals }]
  }
  cache.set('extensions', extension)
  expect(cache.estimatedBytes).toBeLessThanOrEqual(ANALYTICS_CACHE_BYTES)
  expect(cache.get('largestDirectories')).toBeUndefined()
  expect(cache.get('largestFiles')).toBe(files)
  cache.set('extensions', {
    ...extension,
    extensions: [{ ...extension.extensions[0], extension: 'x'.repeat(ANALYTICS_CACHE_BYTES) }]
  })
  expect(cache.get('extensions')).toBe(extension)
  cache.set('largestDirectories', { ...ranked('directory'), scanId: 'another' })
  expect(cache.get('largestDirectories')).toBeUndefined()
  cache.useScan('replacement')
  expect(cache.estimatedBytes).toBe(0)
  expect(cache.get('largestFiles')).toBeUndefined()
})

test('does not cache a failed aggregate computation', () => {
  const cache = new AnalyticsCache()
  cache.useScan('saved')
  const compute = vi
    .fn<() => InsightsRankingPage>()
    .mockImplementationOnce(() => {
      throw new Error('SQLite read failed')
    })
    .mockReturnValueOnce(ranked('file'))
  expect(() => cache.getOrCompute('largestFiles', compute)).toThrow('SQLite read failed')
  expect(cache.get('largestFiles')).toBeUndefined()
  const result = cache.getOrCompute('largestFiles', compute)
  expect(cache.getOrCompute('largestFiles', compute)).toBe(result)
  expect(compute).toHaveBeenCalledTimes(2)
})
