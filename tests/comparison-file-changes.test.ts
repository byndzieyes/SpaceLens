// @vitest-environment node

import { StatementSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { classifyFileChange, observeComparisonPath } from '../src/main/comparison/classification'
import { readComparisonFileChanges } from '../src/main/storage/comparisonFileChanges'
import { ComparisonWorkspace } from '../src/main/storage/comparisonWorkspace'
import type { CompatiblePair } from '../src/main/storage/comparisonMatchContracts'
import { ScanDatabase } from '../src/main/storage/database'
import type {
  ComparisonCoverage,
  ComparisonFileChange,
  ComparisonFileQuery,
  ComparisonPair
} from '../src/shared/comparison'
import type { FileEntry } from '../src/shared/scan'
import { fixture, publish, type Spec } from './comparison-fixture'
import { createV1Database, seedV1Scan } from './v1-scan-fixture'

const pair = { baselineScanId: 'before', targetScanId: 'after' }
const reverse = { baselineScanId: 'after', targetScanId: 'before' }
const time = '2026-09-01T00:00:00.001Z'
const later = '2026-09-01T00:00:00.002Z'

let db: ScanDatabase
beforeEach(() => {
  db = new ScanDatabase(':memory:')
})
afterEach(() => db.close())

test('excludes the root and paths with no known regular file on either side', () => {
  publish(
    db,
    fixture('before', [
      { key: 'folder', type: 'directory' },
      { key: 'link', type: 'symlink' }
    ])
  )
  publish(
    db,
    fixture('after', [
      { key: 'folder', type: 'directory' },
      { key: 'link', type: 'other' }
    ])
  )
  expect(db.listComparisonFileChanges(pair)).toMatchObject({
    pair,
    offset: 0,
    limit: 20,
    items: [],
    totalCount: 0,
    nextOffset: null
  })
})

function observed(
  entry: FileEntry | undefined,
  coverage: ComparisonCoverage
): ReturnType<typeof observeComparisonPath> {
  const saved = entry
    ? {
        scanId: entry.scanId,
        entryId: entry.id,
        type: entry.type,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt
      }
    : null
  return observeComparisonPath(saved, coverage)
}

function oracle(
  before: ReturnType<typeof fixture>,
  after: ReturnType<typeof fixture>
): ComparisonFileChange[] {
  const from = new Map(
    before.entries.map((entry) => [entry.path.slice(before.scan.rootPath.length + 1), entry])
  )
  const to = new Map(
    after.entries.map((entry) => [entry.path.slice(after.scan.rootPath.length + 1), entry])
  )
  return [...new Set([...from.keys(), ...to.keys()])].sort().flatMap((path) => {
    const change = classifyFileChange(
      path,
      observed(from.get(path), before.snapshot.incomplete ? 'incomplete' : 'complete'),
      observed(to.get(path), after.snapshot.incomplete ? 'incomplete' : 'complete')
    )
    return change ? [change] : []
  })
}

function allPages(query: ComparisonFileQuery): ComparisonFileChange[] {
  const items: ComparisonFileChange[] = []
  let offset = query.offset ?? 0
  for (;;) {
    const page = db.listComparisonFileChanges({ ...query, offset })
    expect(page.offset).toBe(offset)
    expect(page.items).toHaveLength(Math.min(page.limit, Math.max(0, page.totalCount - offset)))
    items.push(...page.items)
    if (page.nextOffset === null) {
      expect(items.length).toBe(Math.max(0, page.totalCount - (query.offset ?? 0)))
      return items
    }
    expect(page.nextOffset).toBe(offset + page.items.length)
    offset = page.nextOffset
  }
}

function variants(partial: boolean): Array<Omit<Spec, 'key'> | null> {
  return [
    null,
    { sizeBytes: 0, modifiedAt: time },
    { sizeBytes: 11, modifiedAt: time },
    { sizeBytes: 11, modifiedAt: later },
    { sizeBytes: 21, modifiedAt: later },
    { sizeBytes: 11, modifiedAt: null },
    { sizeBytes: 11, modifiedAt: '2026-02-31T00:00:00.000Z' },
    { type: 'directory' },
    { type: 'symlink' },
    { type: 'other' },
    ...(partial ? [{ sizeBytes: null, modifiedAt: time }, { type: 'unknown' as const }] : [])
  ]
}

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'agrees with the TypeScript oracle for generated entries with coverage flags %s and %s',
  (partialBefore, partialAfter) => {
    const from: Spec[] = []
    const to: Spec[] = []
    for (const [i, baseline] of variants(partialBefore).entries()) {
      for (const [j, target] of variants(partialAfter).entries()) {
        const key = 'item-' + i + '-' + j
        if (baseline) from.push({ ...baseline, key })
        if (target) to.push({ ...target, key })
      }
    }
    const before = fixture('before', from, { errorCount: Number(partialBefore) })
    const after = fixture('after', to, { errorCount: Number(partialAfter) })
    publish(db, before)
    publish(db, after)
    expect(allPages({ ...pair, limit: 9 })).toEqual(oracle(before, after))
    expect(allPages({ ...reverse, limit: 14 })).toEqual(oracle(after, before))

    const warnings = [
      ...(partialBefore ? [{ code: 'INCOMPLETE_COVERAGE', side: 'baseline' }] : []),
      ...(partialAfter ? [{ code: 'INCOMPLETE_COVERAGE', side: 'target' }] : [])
    ]
    expect(db.listComparisonFileChanges(pair).compatibility).toMatchObject({
      pair,
      coverage: {
        baseline: partialBefore ? 'incomplete' : 'complete',
        target: partialAfter ? 'incomplete' : 'complete'
      },
      status: warnings.length ? 'compatible-with-warnings' : 'compatible',
      ...(warnings.length && { warnings })
    })
  }
)

test('matches canonical millisecond timestamps across calendar and Date range boundaries', () => {
  const values = [
    '0000-02-29T00:00:00.001Z',
    '0001-12-31T23:59:59.999Z',
    '9999-12-31T23:59:59.999Z',
    '-000001-12-31T23:59:59.999Z',
    '-000004-02-29T00:00:00.000Z',
    '+010000-02-29T00:00:00.000Z',
    '-271821-04-20T00:00:00.000Z',
    '+275760-09-13T00:00:00.000Z',
    '-271821-04-19T23:59:59.999Z',
    '+275760-09-13T00:00:00.001Z',
    '-000000-01-01T00:00:00.000Z',
    '+000001-01-01T00:00:00.000Z',
    '1900-02-29T00:00:00.000Z',
    '+010100-02-29T00:00:00.000Z',
    '2026-09-01T24:00:00.000Z',
    '2026-09-01T00:00:60.000Z',
    '2026-09-01T00:00:00.001+00:00',
    '2026-09-01T00:00:00.0010Z',
    '2026-09-01T00:00:00Z',
    'unusable timestamp',
    time,
    later,
    ...Array.from({ length: 39 }, (_, i) => new Date(-8.64e15 + i * 443087194308123).toISOString())
  ]
  const from: Spec[] = []
  const to: Spec[] = []
  for (const [i, modifiedAt] of values.entries()) {
    from.push({ key: 'equal-' + i, modifiedAt }, { key: 'different-' + i, modifiedAt })
    to.push({ key: 'equal-' + i, modifiedAt }, { key: 'different-' + i, modifiedAt: time })
  }
  const before = fixture('before', from)
  const after = fixture('after', to)
  publish(db, before)
  publish(db, after)
  expect(allPages({ ...pair, limit: 100 })).toEqual(oracle(before, after))
})

test('preserves signed safe-integer boundaries, zero-byte path changes and reasons', () => {
  const max = Number.MAX_SAFE_INTEGER
  publish(
    db,
    fixture('before', [
      { key: 'dir', type: 'directory' },
      { key: 'dir/unchanged', sizeBytes: 0 },
      { key: 'remove', sizeBytes: max },
      { key: 'old-name', sizeBytes: 0 },
      { key: 'dir/old-place', sizeBytes: 0 }
    ])
  )
  publish(
    db,
    fixture('after', [
      { key: 'dir', type: 'directory' },
      { key: 'dir/unchanged', sizeBytes: 0 },
      { key: 'add', sizeBytes: max },
      { key: 'new-name', sizeBytes: 0 },
      { key: 'new-place', sizeBytes: 0 }
    ])
  )
  expect(
    allPages({ ...pair, sort: 'delta-desc' }).map(({ relativePath, kind, deltaBytes }) => [
      relativePath,
      kind,
      deltaBytes
    ])
  ).toEqual([
    ['add', 'added', max],
    ['dir/old-place', 'removed', 0],
    ['dir/unchanged', 'unchanged', 0],
    ['new-name', 'added', 0],
    ['new-place', 'added', 0],
    ['old-name', 'removed', 0],
    ['remove', 'removed', -max]
  ])
  const reverseRows = allPages({ ...reverse, sort: 'delta-asc' })
  expect(reverseRows[0]).toMatchObject({ relativePath: 'add', kind: 'removed', deltaBytes: -max })
  expect(reverseRows.at(-1)).toMatchObject({
    relativePath: 'remove',
    kind: 'added',
    deltaBytes: max
  })
})

test('rejects a corrupted byte contribution before converting it to a JavaScript number', () => {
  using database = createV1Database(':memory:')
  const workspace = new ComparisonWorkspace(database)
  const before = fixture('before', [{ key: 'report' }])
  const after = fixture('after', [{ key: 'report' }])
  seedV1Scan(database, before.scan, before.entries)
  seedV1Scan(database, after.scan, after.entries)
  const compatible: CompatiblePair = {
    pair,
    pathStyle: 'posix',
    normalizedRoot: before.scan.rootPath,
    coverage: { baseline: 'complete', target: 'complete' },
    status: 'compatible'
  }
  database.exec('BEGIN')
  workspace.prepare(compatible, before.snapshot, after.snapshot)
  database.exec('COMMIT')
  workspace.commit(pair)
  database.exec(
    "UPDATE entries SET size_bytes = 9007199254740992 WHERE scan_id = 'before' AND type = 'file'"
  )
  expect(() =>
    readComparisonFileChanges(database, compatible, { ...pair, limit: 20, offset: 0, sort: 'path' })
  ).toThrow(expect.objectContaining({ code: 'SIZE_OVERFLOW' }))
})

test('filters by kind and component-bounded subtree, including an exact-key replacement', () => {
  const before = fixture('before', [
    { key: 'folder', type: 'directory' },
    { key: 'folder/A' },
    { key: 'folder/a' },
    { key: 'folder/sub', type: 'directory' },
    { key: 'folder/sub/🧭' },
    { key: 'folder-other' },
    { key: 'folder0' },
    { key: 'unknown-time', modifiedAt: null },
    { key: 'modified' },
    { key: 'same' }
  ])
  const after = fixture('after', [
    { key: 'folder' },
    { key: 'folder-other' },
    { key: 'folder0' },
    { key: 'unknown-time', modifiedAt: null },
    { key: 'modified', sizeBytes: 7 },
    { key: 'same' }
  ])
  publish(db, before)
  publish(db, after)
  const expected = oracle(before, after)
  expect(allPages({ ...pair, relativeDirectory: 'folder', limit: 1 })).toEqual(
    expected.filter(({ relativePath: path }) => path === 'folder' || path.startsWith('folder/'))
  )
  expect(allPages({ ...pair, relativeDirectory: 'folder/sub' })).toEqual(
    expected.filter(({ relativePath: path }) => path.startsWith('folder/sub/'))
  )
  expect(allPages({ ...pair, relativeDirectory: '' })).toEqual(expected)
  expect(allPages({ ...pair, relativeDirectory: 'missing' })).toEqual([])
  for (const kind of ['added', 'removed', 'modified', 'unchanged', 'indeterminate'] as const) {
    const matches = expected.filter((entry) => entry.kind === kind)
    expect(matches.length).toBeGreaterThan(0)
    expect(allPages({ ...pair, kinds: [kind], limit: 1 })).toEqual(matches)
  }
  expect(allPages({ ...pair, kinds: ['added', 'removed', 'added'] })).toEqual(
    expected.filter(({ kind }) => kind === 'added' || kind === 'removed')
  )
  expect(db.listComparisonFileChanges({ ...pair, kinds: [] })).toMatchObject({
    items: [],
    totalCount: 0,
    nextOffset: null
  })
})

test('uses signed sorts and UTF-16 tie-breaks across bounded pages with unknown deltas last', () => {
  const keys = [
    'A',
    'a',
    'e\u0301',
    'é',
    '\ud800',
    '🧭',
    '\uffff',
    ...Array.from({ length: 235 }, (_, i) => 'tie-' + i)
  ]
  const before = fixture(
    'before',
    [
      ...keys.map((key) => ({ key, sizeBytes: 5 })),
      { key: 'growth', sizeBytes: 0 },
      { key: 'reduction', sizeBytes: 7 },
      { key: 'unknown', sizeBytes: null }
    ],
    { errorCount: 1 }
  )
  const after = fixture('after', [
    ...keys.map((key) => ({ key, sizeBytes: 7 })),
    { key: 'growth', sizeBytes: 3 },
    { key: 'reduction', sizeBytes: 0 },
    { key: 'unknown', sizeBytes: 1 }
  ])
  publish(db, before)
  publish(db, after)
  const expected = oracle(before, after)
  for (const [sort, direction] of [
    ['delta-asc', 1],
    ['delta-desc', -1]
  ] as const) {
    const sorted = [...expected].sort((left, right) => {
      if (left.deltaBytes === null) return right.deltaBytes === null ? 0 : 1
      if (right.deltaBytes === null) return -1
      return Math.sign(left.deltaBytes - right.deltaBytes) * direction
    })
    expect(allPages({ ...pair, sort, limit: 100 })).toEqual(sorted)
    expect(sorted.at(-1)).toMatchObject({ relativePath: 'unknown', deltaBytes: null })
  }
  expect(allPages({ ...pair, limit: 100 })).toEqual(expected)
  expect(db.listComparisonFileChanges({ ...pair, offset: Number.MAX_SAFE_INTEGER })).toMatchObject({
    items: [],
    totalCount: expected.length,
    nextOffset: null
  })
})

test.each([
  { offset: -1 },
  { offset: Number.MAX_SAFE_INTEGER + 1 },
  { offset: 0.5 },
  { limit: 101 },
  { limit: 0 },
  { limit: null },
  { sort: 'delta-abs' },
  { sort: 'path; SELECT 1' },
  { relativeDirectory: '../other' },
  { relativeDirectory: 'a//b' },
  { relativeDirectory: '/root' },
  { kinds: ['constructor'] },
  { kinds: ['added', null] },
  { kinds: 'added' },
  { after: '' },
  { targetScanId: 'another/path' }
])('rejects invalid query options before using the workspace (%j)', (request) => {
  const prepare = vi.spyOn(ComparisonWorkspace.prototype, 'prepare')
  expect(() => db.listComparisonFileChanges({ ...pair, ...request })).toThrow(
    expect.objectContaining({ code: 'INVALID_REQUEST' })
  )
  expect(prepare).not.toHaveBeenCalled()
})

test('shares one workspace with matching across filters, mutations and directional pair changes', () => {
  publish(db, fixture('before', [{ key: 'only-before' }]))
  publish(db, fixture('after', [{ key: 'only-after' }]))
  const prepare = vi.spyOn(ComparisonWorkspace.prototype, 'prepare')
  db.listComparisonMatches(pair)
  expect(prepare).toHaveBeenCalledTimes(1)
  const initial = db.listComparisonFileChanges(pair)
  expect(initial.items).toHaveLength(2)
  expect(
    db.listComparisonFileChanges({ ...pair, kinds: ['removed'], sort: 'delta-asc' }).items
  ).toHaveLength(1)
  publish(db, fixture('unrelated'))
  db.deleteSnapshot({ scanId: 'unrelated' })
  expect(db.listComparisonFileChanges(pair)).toEqual(initial)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(db.listComparisonFileChanges(reverse).items[0]).toMatchObject({
    relativePath: 'only-after',
    kind: 'removed'
  })
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(db.listComparisonFileChanges(pair)).toEqual(initial)
  expect(prepare).toHaveBeenCalledTimes(3)
})

test.each(['baselineScanId', 'targetScanId'] as const)(
  'rejects the pair after deletion of %s',
  (field) => {
    publish(db, fixture('before', [{ key: 'original' }]))
    publish(db, fixture('after', [{ key: 'current' }]))
    expect(db.listComparisonFileChanges(pair).items).toHaveLength(2)
    db.deleteSnapshot({ scanId: pair[field] })
    expect(() => db.listComparisonFileChanges(pair)).toThrow(
      expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
    )
    publish(db, fixture(pair[field], [{ key: 'new' }]))
    expect(
      db.listComparisonFileChanges(pair).items.map(({ relativePath }) => relativePath)
    ).toEqual(field === 'baselineScanId' ? ['current', 'new'] : ['new', 'original'])
  }
)

test('retains typed pair validation even with an empty kind filter', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after', [], { root: '/elsewhere' }))
  const active = fixture('active').building
  db.beginScan(active)
  const rejected: Array<[ComparisonPair, string]> = [
    [pair, 'INCOMPATIBLE_SNAPSHOTS'],
    [{ ...pair, targetScanId: 'active' }, 'SNAPSHOT_UNAVAILABLE'],
    [{ ...pair, targetScanId: 'missing' }, 'SNAPSHOT_EXPIRED'],
    [{ ...pair, targetScanId: 'before' }, 'INCOMPATIBLE_SNAPSHOTS']
  ]
  for (const [ids, code] of rejected) {
    expect(() => db.listComparisonFileChanges({ ...ids, kinds: [] })).toThrow(
      expect.objectContaining({ code })
    )
  }
})

test('counts in SQL and sends only the selected rows to JavaScript', () => {
  publish(db, fixture('before'))
  publish(
    db,
    fixture(
      'after',
      Array.from({ length: 121 }, (_, i) => ({ key: 'item-' + i }))
    )
  )
  const all = vi.spyOn(StatementSync.prototype, 'all')
  const get = vi.spyOn(StatementSync.prototype, 'get')
  expect(
    db.listComparisonFileChanges({ ...pair, kinds: ['added'], sort: 'delta-desc', limit: 100 })
  ).toMatchObject({
    totalCount: 121,
    nextOffset: 100
  })
  const selects = all.mock.contexts.flatMap((context, i) =>
    context instanceof StatementSync && context.sourceSQL.includes('FROM file_changes')
      ? [all.mock.results[i].value]
      : []
  ) as unknown[][]
  expect(selects.map((rows) => rows.length)).toEqual([100])
  expect(
    get.mock.contexts.filter(
      (context) =>
        context instanceof StatementSync &&
        context.sourceSQL.includes('SELECT COUNT(*) AS total FROM file_changes')
    )
  ).toHaveLength(1)
})
