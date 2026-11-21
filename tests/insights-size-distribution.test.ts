// @vitest-environment node
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import { prepareFileSizeDistribution } from '../src/main/storage/fileSizeDistribution'
import type { BuildingScan, CompletedScan } from '../src/main/storage/payloads'
import type { FileEntry } from '../src/shared/scan'

const order = ['empty', 'tiny', 'small', 'medium', 'large', 'veryLarge'] as const
const rootPath = resolve('size-distribution-fixture')
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
  name: 'root',
  path: rootPath,
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 0,
  createdAt: null,
  modifiedAt: null
}
let db: ScanDatabase
beforeEach(() => {
  db = new ScanDatabase(':memory:')
})
afterEach(() => db.close())

function publish(sizes: readonly (number | null)[], nested = false): CompletedScan {
  const totalBytes = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
  const child = {
    ...root,
    id: 'nested',
    parentId: root.id,
    name: 'nested',
    path: join(rootPath, 'nested')
  }
  db.beginScan(pending)
  db.transaction(() => {
    db.insertEntry({ ...root, aggregatedSizeBytes: totalBytes })
    if (nested) {
      db.insertEntry({ ...child, aggregatedSizeBytes: totalBytes })
      for (const type of ['symlink', 'other'] as const)
        db.insertEntry({
          ...child,
          type,
          id: type,
          name: type,
          path: join(rootPath, type),
          aggregatedSizeBytes: null
        })
    }
    const parent = nested ? child : root
    sizes.forEach((sizeBytes, index) => {
      const name = `file-${index}.${index % 2 ? 'jpg' : 'txt'}`
      db.insertEntry({
        ...root,
        parentId: parent.id,
        type: 'file',
        id: `entry-${index}`,
        name,
        path: join(parent.path, name),
        sizeBytes,
        aggregatedSizeBytes: null
      })
    })
  })
  return db.publishScan(
    {
      ...pending,
      status: 'completed',
      finishedAt: time,
      summary: {
        fileCount: sizes.length,
        directoryCount: nested ? 2 : 1,
        totalBytes,
        errorCount: sizes.filter((size) => size === null).length
      }
    },
    root.id
  )
}

test.each([
  [0, 'empty'],
  [1, 'tiny'],
  [1_048_575, 'tiny'],
  [1_048_576, 'small'],
  [10_485_759, 'small'],
  [10_485_760, 'medium'],
  [104_857_599, 'medium'],
  [104_857_600, 'large'],
  [1_073_741_823, 'large'],
  [1_073_741_824, 'veryLarge'],
  [1_073_741_825, 'veryLarge'],
  [Number.MAX_SAFE_INTEGER, 'veryLarge']
] as const)('classifies exactly %i bytes as %s', (size, expected) => {
  const scan = publish([size])
  expect(db.getInsightsSizeDistribution(scan.id)).toEqual({
    scanId: scan.id,
    incomplete: false,
    knownSizeCount: 1,
    totals: { fileCount: 1, knownBytes: size, unknownSizeCount: 0 },
    buckets: order.map((id) => ({
      id,
      fileCount: id === expected ? 1 : 0,
      knownBytes: id === expected ? size : 0
    }))
  })
})

test.each([
  { name: 'empty', sizes: [], known: 0, unknown: 0 },
  { name: 'known zeros only', sizes: [0, 0, 0], known: 3, unknown: 0 },
  { name: 'unknown sizes only', sizes: [null, null], known: 0, unknown: 2 }
])('returns six ordered buckets for $name', ({ sizes, known, unknown }) => {
  const scan = publish(sizes)
  expect(db.getInsightsSizeDistribution(scan.id)).toEqual({
    scanId: scan.id,
    incomplete: unknown > 0,
    knownSizeCount: known,
    totals: { fileCount: sizes.length, knownBytes: 0, unknownSizeCount: unknown },
    buckets: order.map((id) => ({ id, fileCount: id === 'empty' ? known : 0, knownBytes: 0 }))
  })
})

test('reconciles mixed regular files at every depth without counting directory aggregates or other types', () => {
  const scan = publish(
    [0, 17, 1_048_576, 1_048_578, 10_485_760, 104_857_600, 1_073_741_824, null, null],
    true
  )
  expect(db.getInsightsSizeDistribution(scan.id)).toEqual({
    scanId: scan.id,
    incomplete: true,
    knownSizeCount: 7,
    totals: { fileCount: 9, knownBytes: scan.summary.totalBytes, unknownSizeCount: 2 },
    buckets: [
      { id: 'empty', fileCount: 1, knownBytes: 0 },
      { id: 'tiny', fileCount: 1, knownBytes: 17 },
      { id: 'small', fileCount: 2, knownBytes: 2_097_154 },
      { id: 'medium', fileCount: 1, knownBytes: 10_485_760 },
      { id: 'large', fileCount: 1, knownBytes: 104_857_600 },
      { id: 'veryLarge', fileCount: 1, knownBytes: 1_073_741_824 }
    ]
  })
  expect(db.getScan(scan.id)).toEqual(scan)
})

/** Exercise corrupt totals and SQLite integer limits through the actual prepared query. */
function queryRaw(sizes: readonly (bigint | null)[], summary: CompletedScan['summary']): void {
  const connection = new DatabaseSync(':memory:')
  try {
    connection.exec(
      'CREATE TABLE entries (scan_id TEXT NOT NULL, type TEXT NOT NULL, size_bytes INTEGER) STRICT'
    )
    const insert = connection.prepare("INSERT INTO entries VALUES (?, 'file', ?)")
    for (const size of sizes) insert.run(pending.id, size)
    insert.run('other-scan', 10_000_000_000n)
    prepareFileSizeDistribution(connection)({
      ...pending,
      summary,
      status: 'completed',
      finishedAt: time
    })
  } finally {
    connection.close()
  }
}

test.each([
  { name: 'a bucket above the JS safe range', sizes: [9_007_199_254_740_992n] },
  {
    name: 'a total above the JS safe range across individually safe buckets',
    sizes: [9_007_199_254_740_991n, 1n]
  },
  { name: 'SQLite signed 64-bit sum overflow', sizes: [9_223_372_036_854_775_807n, 1_073_741_824n] }
])('reports SIZE_OVERFLOW for $name', ({ sizes }) => {
  expect(() => queryRaw(sizes, { ...pending.summary, fileCount: sizes.length })).toThrow(
    expect.objectContaining({ code: 'SIZE_OVERFLOW' })
  )
})

test.each([
  { fileCount: 2, totalBytes: 1, errorCount: 1 },
  { fileCount: 1, totalBytes: 2, errorCount: 1 },
  { fileCount: 1, totalBytes: 0, errorCount: 0 }
])('rejects inconsistent published metadata %o', (metadata) => {
  expect(() =>
    queryRaw(metadata.errorCount === 0 ? [null] : [1n], { ...metadata, directoryCount: 1 })
  ).toThrow('differs from the published scan summary')
})
