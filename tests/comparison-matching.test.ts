// @vitest-environment node

import { DatabaseSync, StatementSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { comparisonPathKey } from '../src/main/comparison/paths'
import {
  comparisonMetadataForStoredScan,
  evaluateComparisonCompatibility
} from '../src/main/comparison/compatibility'
import type {
  ComparisonMatchPage,
  ComparisonMatchQuery,
  ComparisonMatchRow
} from '../src/main/storage/comparisonMatchContracts'
import { ComparisonWorkspace } from '../src/main/storage/comparisonWorkspace'
import { ScanDatabase } from '../src/main/storage/database'
import { bindFilesystemText } from '../src/main/storage/filesystemText'
import type { ComparisonPair, ComparisonPathStyle } from '../src/shared/comparison'
import type { FileEntry } from '../src/shared/scan'
import { fixture, publish, type Spec } from './comparison-fixture'
import { createV1Database, legacyEntries, legacyScan, seedV1Scan } from './v1-scan-fixture'

const pair = { baselineScanId: 'before', targetScanId: 'after' }

function pageRows(
  read: (query: ComparisonMatchQuery) => ComparisonMatchPage,
  query: ComparisonMatchQuery
): ComparisonMatchRow[] {
  const rows: ComparisonMatchRow[] = []
  let page = read(query)
  for (;;) {
    expect(page.rows.length).toBeLessThanOrEqual(page.limit)
    rows.push(...page.rows)
    if (page.nextAfter === null) return rows
    page = read({ ...query, after: page.nextAfter })
  }
}

function reference(
  before: ReturnType<typeof fixture>,
  after: ReturnType<typeof fixture>,
  style: ComparisonPathStyle
): ComparisonMatchRow[] {
  const byPath = (snapshot: ReturnType<typeof fixture>): Map<string, FileEntry> =>
    new Map(
      snapshot.entries.map((entry) => [
        comparisonPathKey(snapshot.scan.rootPath, entry, style)!,
        entry
      ])
    )
  const left = byPath(before)
  const right = byPath(after)
  return [...new Set([...left.keys(), ...right.keys()])].sort().map((relativePath) => ({
    relativePath,
    baseline: left.get(relativePath) ?? null,
    target: right.get(relativePath) ?? null
  }))
}

let db: ScanDatabase
beforeEach(() => {
  db = new ScanDatabase(':memory:')
})
afterEach(() => db.close())

function withDatabaseFile(operation: (path: string) => void): void {
  const directory = resolve(mkdtempSync(join(tmpdir(), 'spacelens-comparison-')))
  if (
    dirname(directory) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('spacelens-comparison-')
  )
    throw new Error('Refusing to remove a path outside comparison fixtures.')
  try {
    operation(join(directory, 'scans.sqlite'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('includes the root for two empty directories and uses it as a real cursor boundary', () => {
  const before = fixture('before')
  const after = fixture('after')
  publish(db, before)
  publish(db, after)
  const page = db.listComparisonMatches({ ...pair, limit: 1 })
  expect(page.rows).toEqual(reference(before, after, 'posix'))
  expect(page.nextAfter).toBeNull()
  expect(db.listComparisonMatches({ ...pair, after: '' }).rows).toEqual([])
})

test('matches different IDs, keeps overlapping IDs scan-scoped and preserves types, unknowns and coverage', () => {
  const before = fixture(
    'before',
    [
      { key: 'a', type: 'directory' },
      { key: 'a/item' },
      { key: 'b', type: 'directory' },
      { key: 'b/item' },
      { key: 'f-to-d', type: 'file', id: 'overlap' },
      { key: 'd-to-f', type: 'directory' },
      { key: 'baseline-only', sizeBytes: null, modifiedAt: null },
      { key: 'literal\\backslash', sizeBytes: 0 },
      { key: 'Upper' },
      { key: '\ud800' },
      { key: '🧭' },
      { key: '\uffff' },
      { key: 'é' },
      { key: 'e\u0301' }
    ],
    { errorCount: 1 }
  )
  const after = fixture(
    'after',
    [
      { key: 'a', type: 'directory' },
      { key: 'a/item' },
      { key: 'b', type: 'directory' },
      { key: 'f-to-d', type: 'directory' },
      { key: 'd-to-f', type: 'file', sizeBytes: 0, modifiedAt: null },
      { key: 'target-only', id: 'overlap' },
      { key: 'literal\\backslash', sizeBytes: 0 },
      { key: 'upper' },
      { key: '🧭' },
      { key: 'é' }
    ],
    { errorCount: 2 }
  )
  publish(db, before)
  publish(db, after)
  const read = (query: ComparisonMatchQuery): ComparisonMatchPage => db.listComparisonMatches(query)
  const firstPage = read({ ...pair, limit: 1 })
  expect(firstPage.nextAfter).toBe('')
  expect(firstPage.compatibility).toMatchObject({
    status: 'compatible-with-warnings',
    coverage: { baseline: 'incomplete', target: 'incomplete' },
    warnings: [
      { code: 'INCOMPLETE_COVERAGE', side: 'baseline' },
      { code: 'INCOMPLETE_COVERAGE', side: 'target' }
    ]
  })
  const rows = pageRows(read, { ...pair, limit: 3 })
  expect(rows).toEqual(reference(before, after, 'posix'))
  expect(rows.find(({ relativePath }) => relativePath === 'f-to-d')).toMatchObject({
    baseline: { id: 'overlap', scanId: 'before', type: 'file' },
    target: { scanId: 'after', type: 'directory' }
  })
  expect(rows.find(({ relativePath }) => relativePath === 'target-only')).toMatchObject({
    baseline: null,
    target: { id: 'overlap', scanId: 'after' }
  })
  expect(rows.find(({ relativePath }) => relativePath === 'baseline-only')).toMatchObject({
    baseline: { sizeBytes: null, modifiedAt: null },
    target: null
  })
  expect(pageRows(read, { baselineScanId: 'after', targetScanId: 'before', limit: 100 })).toEqual(
    reference(after, before, 'posix')
  )
})

test.each([
  ['C:\\', 'c:/', 'C:\\Dir\\A', 'c:/Dir/A'],
  ['\\\\Server\\Share', '\\\\Server\\Share\\', '//Server/Share/Dir/A', '\\\\Server\\Share/Dir\\A']
])(
  'agrees with platform-specific reference keys for %s',
  (baselineRoot, targetRoot, oldPath, newPath) => {
    // Use the real Phase 4 storage layout to exercise either spelling on any test host.
    using sqlite = createV1Database(':memory:')
    const workspace = new ComparisonWorkspace(sqlite)
    const before = fixture(
      'before',
      [
        { key: 'Dir', type: 'directory' },
        { key: 'Dir/A', rawPath: oldPath }
      ],
      { style: 'win32', root: baselineRoot }
    )
    const after = fixture(
      'after',
      [{ key: 'Dir', type: 'directory' }, { key: 'Dir/A', rawPath: newPath }, { key: 'Dir/a' }],
      { style: 'win32', root: targetRoot }
    )
    seedV1Scan(sqlite, before.scan, before.entries)
    seedV1Scan(sqlite, after.scan, after.entries)
    const compatible = evaluateComparisonCompatibility(
      pair,
      comparisonMetadataForStoredScan(before.scan),
      comparisonMetadataForStoredScan(after.scan)
    )
    if (compatible.status === 'incompatible') throw new Error(compatible.reason.code)
    sqlite.exec('BEGIN')
    workspace.prepare(compatible, before.snapshot, after.snapshot)
    sqlite.exec('COMMIT')
    workspace.commit(pair)
    expect(workspace.list(compatible, { ...pair, limit: 100 }).rows).toEqual(
      reference(before, after, 'win32')
    )
  }
)

test('matches substantial disjoint siblings and deep paths in bounded pages', () => {
  const deep: Spec[] = []
  let path = 'deep'
  for (let i = 0; i < 24; i++) {
    deep.push({ key: path, type: 'directory' })
    path += '/component-' + 'x'.repeat(32)
  }
  deep.push({ key: path, sizeBytes: Number.MAX_SAFE_INTEGER })
  const makeSiblings = (prefix: string): Spec[] =>
    Array.from({ length: 1001 }, (_, i) => ({
      key: prefix + '-' + i.toString().padStart(4, '0'),
      sizeBytes: 0
    }))
  const before = fixture('before', [...deep, ...makeSiblings('before')])
  const after = fixture('after', [...deep, ...makeSiblings('after')])
  publish(db, before)
  publish(db, after)
  const read = (query: ComparisonMatchQuery): ComparisonMatchPage => db.listComparisonMatches(query)
  const rows = pageRows(read, { ...pair, limit: 100 })
  expect(rows).toEqual(reference(before, after, 'posix'))
  expect(rows.filter(({ baseline, target }) => baseline === null || target === null)).toHaveLength(
    2002
  )
})

test.each([
  ['../scan', 20, undefined],
  ['before', 0, undefined],
  ['before', 101, undefined],
  ['before', 1.5, undefined],
  ['before', 20, '../escape'],
  ['before', 20, '/root'],
  ['before', 20, 'a//b']
])('rejects malformed pair or pagination %s %s %s', (baselineScanId, limit, after) => {
  publish(db, fixture('before'))
  publish(db, fixture('after'))
  expect(() =>
    db.listComparisonMatches({
      ...pair,
      baselineScanId,
      limit,
      ...(after !== undefined && { after })
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})

test('rejects same, missing, running and incompatible pairs without changing Latest or the build', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after', [], { root: '/elsewhere' }))
  const { building } = fixture('running')
  db.beginScan(building)
  expect(() => db.listComparisonMatches({ ...pair, targetScanId: 'before' })).toThrow(
    expect.objectContaining({
      code: 'INCOMPATIBLE_SNAPSHOTS',
      message: expect.stringContaining('SAME_SNAPSHOT')
    })
  )
  expect(() => db.listComparisonMatches({ ...pair, targetScanId: 'missing' })).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
  )
  expect(() => db.listComparisonMatches({ ...pair, targetScanId: 'running' })).toThrow(
    expect.objectContaining({ code: 'SNAPSHOT_UNAVAILABLE' })
  )
  expect(() => db.listComparisonMatches(pair)).toThrow(
    expect.objectContaining({
      code: 'INCOMPATIBLE_SNAPSHOTS',
      message: expect.stringContaining('DIFFERENT_ROOTS')
    })
  )
  expect(db.getPublishedScan()?.id).toBe('after')
  expect(db.getScan('running')).toEqual(building)
})

test.each([
  [{ key: 'x', rawPath: '/comparison/../escape' }, 'INVALID_COMPARISON_PATH'],
  [{ key: 'x', rawPath: '/comparison/other/x' }, 'INVALID_COMPARISON_PATH'],
  [{ key: 'x', rawPath: '/comparison/valid' }, 'AMBIGUOUS_COMPARISON_PATH']
] as const)('rolls back invalid matching preparation for %j', (spec, code) => {
  publish(db, fixture('before', [{ key: 'valid' }]))
  publish(db, fixture('after', [{ key: 'valid' }]))
  publish(db, fixture('invalid', [{ key: 'valid' }, spec]))
  const healthy = db.listComparisonMatches(pair)
  const failing = { baselineScanId: 'before', targetScanId: 'invalid' }
  expect(() => db.listComparisonMatches(failing)).toThrow(expect.objectContaining({ code }))
  expect(() => db.listComparisonMatches(failing)).toThrow(expect.objectContaining({ code }))
  expect(db.listComparisonMatches(pair)).toEqual(healthy)
  expect(db.getScanSnapshot().snapshot?.entries.scanId).toBe('invalid')
  expect(db.getScan('invalid')?.summary.fileCount).toBe(2)
})

test.each(['before', 'after'])('rejects duplicate %s keys across preparation batches', (id) => {
  const spec = [
    { key: 'same', id: 'aaa' },
    ...Array.from({ length: 512 }, (_, i) => ({ key: `filler-${i}`, id: `id-${i}` })),
    { key: 'alias', id: 'zzz', rawPath: '/comparison/same' }
  ]
  publish(db, fixture('before', id === 'before' ? spec : []))
  publish(db, fixture('after', id === 'after' ? spec : []))
  expect(() => db.listComparisonMatches(pair)).toThrow(
    expect.objectContaining({ code: 'AMBIGUOUS_COMPARISON_PATH' })
  )
  expect(db.getPublishedScan()?.id).toBe('after')
})

test('rolls back a SQLite temporary write failure and allows a later comparison and scanner write', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after'))
  const original = StatementSync.prototype.run
  const run = vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (
    this: StatementSync,
    ...args: Parameters<typeof original>
  ) {
    if (this.sourceSQL.includes('temp.comparison_paths (path_key, target_id)'))
      throw Object.assign(new Error('temporary SQLite storage full'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 13
      })
    return original.apply(this, args)
  })
  expect(() => db.listComparisonMatches(pair)).toThrow(expect.objectContaining({ errcode: 13 }))
  run.mockRestore()
  expect(db.listComparisonMatches(pair).rows).toHaveLength(1)
  publish(db, fixture('new'))
  expect(db.getPublishedScan()?.id).toBe('new')
})

test('reuses matching and historical validation across pages and unrelated mutations, with one pair at a time', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after'))
  const prepare = vi.spyOn(ComparisonWorkspace.prototype, 'prepare')
  const gets = vi.spyOn(StatementSync.prototype, 'get')
  const validations = (): number =>
    gets.mock.contexts.filter(
      (context) =>
        context instanceof StatementSync && context.sourceSQL.includes('WITH RECURSIVE reachable')
    ).length
  db.listComparisonMatches(pair)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(validations()).toBe(1)
  db.listComparisonMatches({ ...pair, after: '' })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(validations()).toBe(1)
  publish(db, fixture('new'))
  db.listComparisonMatches(pair)
  db.deleteSnapshot({ scanId: 'new' })
  db.listComparisonMatches(pair)
  expect(prepare).toHaveBeenCalledTimes(1)
  const afterPublish = validations()
  db.listComparisonMatches({ baselineScanId: 'after', targetScanId: 'before' })
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(validations()).toBe(afterPublish)
  db.listComparisonMatches(pair)
  expect(prepare).toHaveBeenCalledTimes(3)
})

test.each(['before', 'after'])('invalidates a workspace after deleting source %s', (id) => {
  publish(db, fixture('before', [{ key: 'old' }]))
  publish(db, fixture('after', [{ key: 'new' }]))
  const read = (query: ComparisonPair): ComparisonMatchPage => db.listComparisonMatches(query)
  expect(read(pair).rows).toHaveLength(3)
  db.deleteSnapshot({ scanId: id })
  expect(() => read(pair)).toThrow(expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' }))
  publish(db, fixture(id, [{ key: 'fresh' }]))
  expect(read(pair).rows.map(({ relativePath }) => relativePath)).toEqual(
    id === 'before' ? ['', 'fresh', 'new'] : ['', 'fresh', 'old']
  )
})

test('rejects a corrupt retained tree before matching it and preserves Latest', () => {
  withDatabaseFile((path) => {
    db.close()
    db = new ScanDatabase(path)
    try {
      publish(db, fixture('before', [{ key: 'old' }]))
      publish(db, fixture('after'))
      using writer = new DatabaseSync(path)
      writer.exec("UPDATE entries SET size_bytes = 999 WHERE scan_id = 'before' AND type = 'file'")
      const prepare = vi.spyOn(ComparisonWorkspace.prototype, 'prepare')
      expect(() => db.listComparisonMatches(pair)).toThrow(
        expect.objectContaining({ code: 'SNAPSHOT_UNAVAILABLE' })
      )
      expect(() => db.listComparisonFileChanges(pair)).toThrow(
        expect.objectContaining({ code: 'SNAPSHOT_UNAVAILABLE' })
      )
      expect(prepare).not.toHaveBeenCalled()
      expect(db.getScanSnapshot().snapshot?.entries.scanId).toBe('after')
    } finally {
      db.close()
    }
  })
})

test('matches a migrated Phase 4 tree and leaves the permanent SQLite schema untouched', () => {
  withDatabaseFile((path) => {
    db.close()
    {
      using legacy = createV1Database(path)
      seedV1Scan(legacy, legacyScan, Object.values(legacyEntries))
    }
    db = new ScanDatabase(path)
    try {
      db.recoverStorage()
      const sameRoot = fixture('after', [{ key: 'new' }], {
        root: legacyScan.rootPath,
        style: process.platform === 'win32' ? 'win32' : 'posix'
      })
      publish(db, sameRoot)
      const page = db.listComparisonMatches({
        baselineScanId: legacyScan.id,
        targetScanId: 'after',
        limit: 100
      })
      expect(page.compatibility.coverage).toEqual({ baseline: 'incomplete', target: 'complete' })
      expect(
        page.rows.find(({ baseline }) => baseline?.id === legacyEntries.image.id)?.baseline
      ).toEqual(legacyEntries.image)
      expect(
        page.rows.find(({ baseline }) => baseline?.id === legacyEntries.unknown.id)?.baseline
          ?.sizeBytes
      ).toBeNull()
      using reader = new DatabaseSync(path)
      expect(reader.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
      expect(
        reader.prepare("SELECT name FROM main.sqlite_schema WHERE name LIKE '%comparison%'").all()
      ).toEqual([])
      expect(
        reader
          .prepare('SELECT path FROM entries WHERE scan_id = ? AND id = ?')
          .get(legacyScan.id, legacyEntries.image.id)?.path
      ).toEqual(Uint8Array.from(bindFilesystemText(legacyEntries.image.path)))
    } finally {
      db.close()
    }
  })
})
