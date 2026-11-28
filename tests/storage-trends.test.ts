// @vitest-environment node

import { expect, test } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import { comparisonSeries } from '../src/main/comparison/compatibility'
import { isTrendBatch, readTrendSelection } from '../src/main/storage/trendsContracts'
import type { CompletedScan } from '../src/main/storage/payloads'
import { ScanStorageCoordinator } from '../src/main/storage/coordinator'
import { readStorageTrends } from '../src/main/storage/readStorageTrends'
import type { StorageWorkerClient } from '../src/main/storage/workerClient'

const date = '2026-11-20T12:00:00.000Z'
function saved(
  id: string,
  rootPath: string,
  bytes: number,
  finishedAt = date,
  errorCount = 0
): CompletedScan {
  return {
    id,
    rootPath,
    status: 'completed',
    startedAt: finishedAt,
    finishedAt,
    summary: { totalBytes: bytes, fileCount: bytes > 0 ? 1 : 0, directoryCount: 1, errorCount }
  }
}

test('groups only compatible lexical roots and preserves publication order, safe bytes, and partial coverage', () => {
  const db = new ScanDatabase(':memory:')
  try {
    db.insertScan(saved('older', 'C:\\Media\\Café\\', 0))
    db.insertScan(saved('decomposed', 'C:/Media/Cafe\u0301', 55))
    db.insertScan(saved('case', 'C:/media/Café', 44))
    db.insertScan(
      saved('second', 'c:/Media\\Café', Number.MAX_SAFE_INTEGER, '2026-11-19T05:00:00.000Z', 1)
    )
    db.insertScan(saved('third', 'C:/Media/Café', 10))
    db.insertScan(saved('ambiguous', '//server/share', 40))
    db.insertScan(saved('new-global', '/different', 20))
    const batch = db.readTrendBatch({
      selection: { mode: 'snapshot', scanId: 'older' },
      pointLimit: 100
    })
    expect(batch).toMatchObject({
      series: {
        normalizedRoot: 'c:/Media/Café',
        pathStyle: 'win32',
        traversalPolicy: 'spacelens-v1-v2'
      },
      latestCompletedScanId: 'new-global',
      matchedCount: 3,
      nextBefore: null,
      points: [
        { id: 'third', finishedAt: date, totalBytes: 10, incomplete: false },
        { id: 'second', totalBytes: Number.MAX_SAFE_INTEGER, incomplete: true },
        { id: 'older', finishedAt: date, totalBytes: 0, incomplete: false }
      ]
    })
    expect(isTrendBatch(batch)).toBe(true)
    expect(
      db
        .readTrendBatch({ selection: { mode: 'latest' }, pointLimit: 100 })
        .points.map(({ id }) => id)
    ).toEqual(['new-global'])
    expect(() =>
      db.readTrendBatch({ selection: { mode: 'snapshot', scanId: 'ambiguous' }, pointLimit: 100 })
    ).toThrow(expect.objectContaining({ code: 'SNAPSHOT_UNAVAILABLE' }))
  } finally {
    db.close()
  }
})

test('bounds point collection and continues counting across indexed batches, even after its anchor is removed', () => {
  const db = new ScanDatabase(':memory:')
  try {
    const empty = db.readTrendBatch({ selection: { mode: 'latest' }, pointLimit: 100 })
    expect(empty).toMatchObject({
      series: null,
      latestCompletedScanId: null,
      matchedCount: 0,
      points: []
    })
    for (let n = 0; n < 145; n++) db.insertScan(saved('archive-' + n, '/archive', n))
    const batch = db.readTrendBatch({ selection: { mode: 'latest' }, pointLimit: 100 })
    expect(batch.matchedCount).toBe(128)
    expect(batch.points).toHaveLength(100)
    expect(batch.points[0].id).toBe('archive-144')
    expect(batch.points.at(-1)?.id).toBe('archive-45')
    const selection = { mode: 'series', series: batch.series! } as const
    const tail = db.readTrendBatch({ selection, pointLimit: 0, before: batch.nextBefore! })
    expect(tail).toMatchObject({
      matchedCount: 17,
      points: [],
      nextBefore: null,
      generation: batch.generation
    })
    db.deleteSnapshot({ scanId: 'archive-144' })
    const after = db.readTrendBatch({ selection, pointLimit: 1 })
    expect(after.generation).toBeGreaterThan(batch.generation)
    expect(after.latestCompletedScanId).toBe('archive-143')
    expect(after.points.map(({ id }) => id)).toEqual(['archive-143'])
    expect(() =>
      db.readTrendBatch({ selection: { mode: 'snapshot', scanId: 'archive-144' }, pointLimit: 100 })
    ).toThrow(expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' }))
  } finally {
    db.close()
  }
})

test('validates canonical series identities, cursor limits and worker result bounds', () => {
  const key = comparisonSeries('C:\\Root\\')!
  expect(readTrendSelection({ mode: 'series', series: key })).toEqual({
    mode: 'series',
    series: key
  })
  for (const bad of [
    { mode: 'series', series: { ...key, traversalPolicy: 'unknown' } },
    { mode: 'series', series: { ...key, normalizedRoot: 'C:\\Root\\' } },
    { mode: 'snapshot', scanId: '../not-an-id' },
    { mode: 'latest', pointLimit: 1000 }
  ])
    expect(() => readTrendSelection(bad)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
  const db = new ScanDatabase(':memory:')
  try {
    for (const query of [
      { selection: { mode: 'latest' }, pointLimit: 101 },
      { selection: { mode: 'latest' }, pointLimit: 100, before: 2n },
      { selection: { mode: 'series', series: key }, pointLimit: 10, before: 0n }
    ])
      expect(() => db.readTrendBatch(query)).toThrow(
        expect.objectContaining({ code: 'INVALID_REQUEST' })
      )
    db.insertScan(saved('a', '/a', 0))
    const batch = db.readTrendBatch({ selection: { mode: 'latest' }, pointLimit: 100 })
    expect(isTrendBatch({ ...batch, matchedCount: 129 })).toBe(false)
    expect(
      isTrendBatch({ ...batch, matchedCount: 101, points: Array(101).fill(batch.points[0]) })
    ).toBe(false)
    expect(
      isTrendBatch({ ...batch, matchedCount: 2, points: [batch.points[0], batch.points[0]] })
    ).toBe(false)
  } finally {
    db.close()
  }
})

test('counts 5,000 mixed-root publications in bounded admissions and retains only the newest 100 matches', async () => {
  const db = new ScanDatabase(':memory:')
  const ids = Array.from({ length: 5000 }, (_, n) => 'archive-' + n)
  const matching = ids.filter((_, n) => n % 5 < 2)
  let batches = 0
  const exit = Promise.withResolvers<void>()
  const client = {
    isReady: true,
    waitForExit: () => exit.promise,
    readTrendBatch: async (request: Parameters<StorageWorkerClient['readTrendBatch']>[0]) => {
      batches++
      const result = db.readTrendBatch(request)
      expect(isTrendBatch(result)).toBe(true)
      return result
    }
  }
  try {
    const roots = [
      'C:\\Archive\\Café',
      'c:/Archive/Café/',
      'C:/archive/Café',
      'C:/Archive/Cafe\u0301',
      '//ambiguous/root'
    ]
    db.transaction(() => {
      for (const [n, id] of ids.entries())
        db.insertScan(saved(id, roots[n % roots.length], n, date, n % 7 === 0 ? 1 : 0))
    })
    const storage = new ScanStorageCoordinator(Promise.resolve(client as StorageWorkerClient))
    const result = await readStorageTrends(storage, new AbortController().signal, {
      mode: 'snapshot',
      scanId: ids[0]
    })
    expect(batches).toBe(40)
    expect(result?.retainedCount).toBe(2000)
    expect(result?.latestCompletedScanId).toBe(ids.at(-1))
    expect(result?.points.map(({ id }) => id)).toEqual(matching.slice(-100))
    expect(result?.points.some(({ incomplete }) => incomplete)).toBe(true)
  } finally {
    exit.resolve()
    db.close()
  }
})
