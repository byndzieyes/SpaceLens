// @vitest-environment node

import { StatementSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { prepareComparisonDirectories } from '../src/main/storage/comparisonDirectoryAnalysis'
import type { CompatiblePair } from '../src/main/storage/comparisonMatchContracts'
import { ComparisonWorkspace } from '../src/main/storage/comparisonWorkspace'
import { ScanDatabase } from '../src/main/storage/database'
import type {
  ComparisonDirectoryChange,
  ComparisonDirectoryObservation,
  ComparisonDirectoryQuery,
  EntryChangeKind
} from '../src/shared/comparison'
import type { FileEntry } from '../src/shared/scan'
import { expectedFiles, fixture, oracle, publish, type Spec } from './comparison-fixture'
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

function pages(query: ComparisonDirectoryQuery): ComparisonDirectoryChange[] {
  const items: ComparisonDirectoryChange[] = []
  let offset = query.offset ?? 0
  for (;;) {
    const page = db.listComparisonDirectoryChanges({ ...query, offset })
    expect(page.items.length).toBe(Math.min(page.limit, Math.max(0, page.totalCount - offset)))
    items.push(...page.items)
    if (page.nextOffset === null) {
      expect(items.length).toBe(Math.max(0, page.totalCount - (query.offset ?? 0)))
      return items
    }
    expect(page.nextOffset).toBe(offset + page.items.length)
    offset = page.nextOffset
  }
}

function directoryObservation(
  entry: FileEntry | undefined,
  incomplete: boolean
): ComparisonDirectoryObservation {
  if (entry?.type === 'directory') {
    return {
      presence: 'present',
      observedBytes: entry.aggregatedSizeBytes,
      entry: { type: 'directory', scanId: entry.scanId, entryId: entry.id }
    }
  }
  return { presence: entry?.type === 'unknown' || (!entry && incomplete) ? 'unknown' : 'absent' }
}

/** Small-fixture oracle deliberately scans prefixes instead of using SQL parent propagation. */
function directoryOracle(
  before: ReturnType<typeof fixture>,
  after: ReturnType<typeof fixture>
): ComparisonDirectoryChange[] {
  const entries = (snapshot: ReturnType<typeof fixture>): Map<string, FileEntry> =>
    new Map(
      snapshot.entries.map((entry) => [entry.path.slice(snapshot.scan.rootPath.length + 1), entry])
    )
  const from = entries(before)
  const to = entries(after)
  const files = oracle(before, after)
  const structural = [...new Set([...from.keys(), ...to.keys()])].sort().flatMap((relativePath) => {
    const old = from.get(relativePath)
    const current = to.get(relativePath)
    if (old?.type !== 'directory' && current?.type !== 'directory') return []
    const baseline = directoryObservation(old, before.snapshot.incomplete)
    const target = directoryObservation(current, after.snapshot.incomplete)
    const kind: EntryChangeKind =
      baseline.presence === 'absent'
        ? 'added'
        : target.presence === 'absent'
          ? 'removed'
          : baseline.presence === 'unknown' || target.presence === 'unknown'
            ? 'indeterminate'
            : 'unchanged'
    const replacement = [old?.type, current?.type].some(
      (type) => type === 'file' || type === 'symlink' || type === 'other'
    )
    return [{ relativePath, baseline, target, kind, typeReplacement: replacement }]
  })
  const value = (observation: ComparisonDirectoryObservation): number | null =>
    observation.presence === 'present'
      ? observation.observedBytes
      : observation.presence === 'absent'
        ? 0
        : null
  return structural.map((record) => {
    const descendant = (key: string): boolean =>
      record.relativePath === '' ? key !== '' : key.startsWith(record.relativePath + '/')
    const subtreeFiles = expectedFiles(files.filter(({ relativePath }) => descendant(relativePath)))
    const from = value(record.baseline),
      to = value(record.target)
    const observedDeltaBytes = from === null || to === null ? null : to - from
    const uncertain =
      before.snapshot.incomplete ||
      after.snapshot.incomplete ||
      observedDeltaBytes === null ||
      subtreeFiles.unknownDeltaCount !== 0 ||
      subtreeFiles.counts.indeterminate !== 0
    const changed =
      subtreeFiles.counts.added + subtreeFiles.counts.removed + subtreeFiles.counts.modified > 0 ||
      structural.some(
        ({ relativePath, kind }) =>
          descendant(relativePath) && (kind === 'added' || kind === 'removed')
      )
    const kind =
      record.kind !== 'unchanged'
        ? record.kind
        : changed
          ? 'modified'
          : uncertain
            ? 'indeterminate'
            : 'unchanged'
    return { ...record, kind, observedDeltaBytes, uncertain, subtreeFiles }
  })
}

const dir = (key: string): Spec => ({ key, type: 'directory' })

test('keeps the root opt-in for empty, identical snapshots', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after'))
  expect(db.listComparisonDirectoryChanges(pair)).toMatchObject({
    items: [],
    totalCount: 0,
    nextOffset: null
  })
  const summary = db.getComparisonSummary(pair)
  const [root] = pages({ ...pair, includeRoot: true })
  expect(root).toMatchObject({
    relativePath: '',
    kind: 'unchanged',
    uncertain: false,
    observedDeltaBytes: 0,
    baseline: {
      presence: 'present',
      entry: { scanId: 'before', entryId: 'root', type: 'directory' }
    },
    target: { presence: 'present', entry: { scanId: 'after', entryId: 'root', type: 'directory' } },
    subtreeFiles: summary.files
  })
})

test('classifies changes in bytes, timestamps and empty directory structure independently', () => {
  const before = fixture('before', [
    dir('grow'),
    { key: 'grow/report', sizeBytes: 1 },
    dir('reduce'),
    { key: 'reduce/report', sizeBytes: 7 },
    dir('zero'),
    { key: 'zero/report', sizeBytes: 4, modifiedAt: time },
    dir('structure'),
    dir('structure/nested'),
    dir('structure/nested/removed'),
    dir('unchanged'),
    { key: 'unchanged/report', sizeBytes: 6 },
    dir('unknown'),
    { key: 'unknown/report', sizeBytes: 6, modifiedAt: null },
    { key: 'root-report', sizeBytes: 4 }
  ])
  const after = fixture('after', [
    dir('grow'),
    { key: 'grow/report', sizeBytes: 8 },
    dir('reduce'),
    { key: 'reduce/report', sizeBytes: 2 },
    dir('zero'),
    { key: 'zero/report', sizeBytes: 4, modifiedAt: later },
    dir('structure'),
    dir('structure/nested'),
    dir('structure/nested/added'),
    dir('unchanged'),
    { key: 'unchanged/report', sizeBytes: 6 },
    dir('unknown'),
    { key: 'unknown/report', sizeBytes: 6, modifiedAt: null },
    { key: 'root-report', sizeBytes: 5 }
  ])
  publish(db, before)
  publish(db, after)
  const summary = db.getComparisonSummary(pair)
  const actual = pages({ ...pair, limit: 5, includeRoot: true })
  expect(actual).toEqual(directoryOracle(before, after))
  expect(actual[0].subtreeFiles).toEqual(summary.files)
  const lookup = (path: string): ComparisonDirectoryChange | undefined =>
    actual.find(({ relativePath }) => path === relativePath)
  expect(lookup('grow')).toMatchObject({ kind: 'modified', observedDeltaBytes: 7 })
  expect(lookup('reduce')).toMatchObject({ kind: 'modified', observedDeltaBytes: -5 })
  expect(lookup('zero')).toMatchObject({ kind: 'modified', observedDeltaBytes: 0 })
  expect(lookup('structure')).toMatchObject({
    kind: 'modified',
    observedDeltaBytes: 0,
    subtreeFiles: { totalCount: 0 }
  })
  expect(lookup('structure/nested/added')).toMatchObject({ kind: 'added', observedDeltaBytes: 0 })
  expect(lookup('structure/nested/removed')).toMatchObject({
    kind: 'removed',
    observedDeltaBytes: 0
  })
  expect(lookup('unchanged')).toMatchObject({
    kind: 'unchanged',
    uncertain: false,
    observedDeltaBytes: 0
  })
  expect(lookup('unknown')).toMatchObject({
    kind: 'indeterminate',
    uncertain: true,
    subtreeFiles: {
      counts: { indeterminate: 1 },
      knownDeltaCount: 1,
      netKnownDeltaBytes: 0,
      confirmedKnownDeltaBytes: 0
    }
  })
  expect(db.listComparisonDirectoryChanges({ ...pair, sort: 'delta-desc' }).items[0]).toMatchObject(
    { relativePath: 'grow' }
  )
  expect(db.listComparisonDirectoryChanges({ ...pair, sort: 'delta-asc' }).items[0]).toMatchObject({
    relativePath: 'reduce'
  })
})

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'handles strict descendants, type replacements and coverage flags %s / %s',
  (partialBefore, partialAfter) => {
    const before = fixture(
      'before',
      [
        dir('Projects'),
        dir('Projects/Web'),
        { key: 'Projects/Web/app', sizeBytes: 4 },
        dir('Projects/WebBackup'),
        { key: 'Projects/WebBackup/app', sizeBytes: 50 },
        { key: 'Projects/FileToDir', sizeBytes: 90 },
        dir('Projects/DirToFile'),
        { key: 'Projects/DirToFile/child', sizeBytes: 3 },
        dir('Projects/UnknownToDir'),
        { key: 'Projects/replaced-link', type: 'symlink' },
        dir('old'),
        { key: 'old/report' },
        ...(partialBefore ? [{ key: 'Projects/size', sizeBytes: null, modifiedAt: time }] : [])
      ],
      { errorCount: Number(partialBefore) }
    )
    const after = fixture(
      'after',
      [
        dir('Projects'),
        dir('Projects/Web'),
        { key: 'Projects/Web/app', sizeBytes: 6 },
        dir('Projects/WebBackup'),
        { key: 'Projects/WebBackup/app', sizeBytes: 70 },
        dir('Projects/FileToDir'),
        { key: 'Projects/FileToDir/child', sizeBytes: 7 },
        { key: 'Projects/DirToFile', sizeBytes: 40 },
        ...(partialAfter ? [{ key: 'Projects/UnknownToDir', type: 'unknown' as const }] : []),
        dir('Projects/replaced-link'),
        dir('new'),
        { key: 'Projects/size', sizeBytes: 2, modifiedAt: later }
      ],
      { errorCount: Number(partialAfter) }
    )
    publish(db, before)
    publish(db, after)
    const actual = pages({ ...pair, limit: 2, includeRoot: true })
    expect(actual).toEqual(directoryOracle(before, after))
    expect(actual[0].subtreeFiles).toEqual(db.getComparisonSummary(pair).files)
    expect(pages({ ...reverse, limit: 3, includeRoot: true })).toEqual(
      directoryOracle(after, before)
    )
    const [changed] = pages({ ...pair, relativeDirectory: 'Projects/FileToDir' })
    expect(changed).toMatchObject({
      kind: 'added',
      typeReplacement: true,
      observedDeltaBytes: 7,
      baseline: { presence: 'absent' },
      target: { presence: 'present', entry: { scanId: 'after', type: 'directory' } }
    })
    expect(changed.subtreeFiles).toMatchObject({
      counts: { removed: 0 },
      totalCount: 1,
      netKnownDeltaBytes: partialBefore ? 0 : 7
    })
    const comparison = db.listComparisonDirectoryChanges({
      ...pair,
      relativeDirectory: 'Projects/Web'
    })
    expect(comparison.items).toHaveLength(1)
    expect(comparison.items[0].observedDeltaBytes).toBe(2)
    expect(comparison.items[0].subtreeFiles).toEqual(
      expectedFiles(
        db.listComparisonFileChanges({ ...pair, relativeDirectory: 'Projects/Web' }).items
      )
    )
    expect(comparison.compatibility.coverage).toEqual({
      baseline: partialBefore ? 'incomplete' : 'complete',
      target: partialAfter ? 'incomplete' : 'complete'
    })
    const replacements = actual.filter(({ typeReplacement }) => typeReplacement)
    expect(
      replacements.map(({ relativePath, kind, observedDeltaBytes }) => [
        relativePath,
        kind,
        observedDeltaBytes
      ])
    ).toEqual([
      ['Projects/DirToFile', 'removed', -3],
      ['Projects/FileToDir', 'added', 7],
      ['Projects/replaced-link', 'added', 0]
    ])
  }
)

test('matches generated directory trees across rollup batches, deep nesting, Unicode and exact case', () => {
  const before: Spec[] = [],
    after: Spec[] = []
  for (const key of [
    'A',
    'a',
    'é',
    'e\u0301',
    '資料',
    '🧭',
    '\ud800',
    ...Array.from({ length: 525 }, (_, i) => 'sibling-' + i)
  ]) {
    before.push(dir(key), { key: key + '/file', sizeBytes: 5 })
    const i = before.length / 2
    if (i % 7 !== 0) after.push(dir(key), { key: key + '/file', sizeBytes: i % 10 })
    if (i % 3 === 0) after.push(dir(key + '-new'))
  }
  let deep = 'deep'
  for (let i = 0; i < 85; i++) {
    before.push(dir(deep))
    after.push(dir(deep))
    deep += '/child'
  }
  before.push({ key: deep, sizeBytes: 10, modifiedAt: time })
  after.push({ key: deep, sizeBytes: 10, modifiedAt: later })
  const baseline = fixture('before', before)
  const target = fixture('after', after)
  publish(db, baseline)
  publish(db, target)
  const expected = directoryOracle(baseline, target)
  expect(pages({ ...pair, includeRoot: true, limit: 100 })).toEqual(expected)
  expect(pages({ ...pair, relativeDirectory: 'deep', limit: 80 })).toEqual(
    expected.filter(
      ({ relativePath }) => relativePath === 'deep' || relativePath.startsWith('deep/')
    )
  )
  for (const sort of ['delta-asc', 'delta-desc'] as const) {
    const sorted = expected
      .filter(({ relativePath }) => relativePath !== '')
      .sort(
        (a, b) =>
          Math.sign(a.observedDeltaBytes! - b.observedDeltaBytes!) * (sort === 'delta-asc' ? 1 : -1)
      )
    expect(pages({ ...pair, sort, limit: 100 })).toEqual(sorted)
  }
  expect(
    db.listComparisonDirectoryChanges({ ...pair, offset: Number.MAX_SAFE_INTEGER })
  ).toMatchObject({
    items: [],
    totalCount: expected.length - 1,
    nextOffset: null
  })
})

test('preserves empty and uncertain records in filtered and sorted results', () => {
  publish(db, fixture('before', [dir('a-unknown'), dir('grow'), { key: 'grow/f' }, dir('removed')]))
  publish(
    db,
    fixture(
      'after',
      [
        dir('b-zero'),
        dir('grow'),
        { key: 'grow/f', sizeBytes: 5 },
        { key: 'removed', type: 'other' }
      ],
      { errorCount: 1 }
    )
  )
  for (const sort of ['delta-asc', 'delta-desc'] as const) {
    expect(pages({ ...pair, sort, limit: 1 }).at(-1)).toMatchObject({
      relativePath: 'a-unknown',
      kind: 'indeterminate',
      observedDeltaBytes: null,
      uncertain: true
    })
  }
  expect(
    pages({ ...pair, kinds: ['added', 'removed'] }).map(
      ({ relativePath, kind, observedDeltaBytes }) => [relativePath, kind, observedDeltaBytes]
    )
  ).toEqual([
    ['b-zero', 'added', 0],
    ['removed', 'removed', 0]
  ])
  expect(
    db.listComparisonDirectoryChanges({ ...pair, relativeDirectory: 'nonexistent' }).items
  ).toEqual([])
  expect(db.listComparisonDirectoryChanges({ ...pair, kinds: [] })).toMatchObject({
    items: [],
    totalCount: 0
  })
})

test.each([
  { includeRoot: 1 },
  { limit: 101 },
  { offset: -1 },
  { offset: Number.MAX_SAFE_INTEGER + 1 },
  { sort: 'delta-abs' },
  { sort: 'path;SELECT 1' },
  { kinds: ['constructor'] },
  { relativeDirectory: 'a/../b' },
  { relativeDirectory: '/absolute' },
  { after: '' }
])('rejects invalid query options before loading snapshots (%j)', (options) => {
  expect(() => db.listComparisonDirectoryChanges({ ...pair, ...options })).toThrow(
    expect.objectContaining({ code: 'INVALID_REQUEST' })
  )
})

test('uses exact signed safe-integer boundary deltas in root and descendants', () => {
  const max = Number.MAX_SAFE_INTEGER
  publish(db, fixture('before', [dir('old'), { key: 'old/maximum', sizeBytes: max }]))
  publish(db, fixture('after', [dir('new'), { key: 'new/maximum', sizeBytes: max }]))
  const [root, added, removed] = pages({ ...pair, includeRoot: true })
  expect(root.subtreeFiles).toMatchObject({
    positiveDeltaBytes: max,
    negativeDeltaBytes: -max,
    netKnownDeltaBytes: 0
  })
  expect(added).toMatchObject({
    kind: 'added',
    observedDeltaBytes: max,
    subtreeFiles: { netKnownDeltaBytes: max }
  })
  expect(removed).toMatchObject({
    kind: 'removed',
    observedDeltaBytes: -max,
    subtreeFiles: { netKnownDeltaBytes: -max }
  })
})

test.each([2, 1025])(
  'rejects overflow while aggregating a disposable corrupted SQLite fixture (%s files)',
  (count) => {
    using raw = createV1Database(':memory:')
    const before = fixture('before')
    const after = fixture('after', [
      dir('target'),
      ...Array.from({ length: count }, (_, i) => ({ key: 'target/file-' + i }))
    ])
    seedV1Scan(raw, before.scan, before.entries)
    seedV1Scan(raw, after.scan, after.entries)
    const compatibility: CompatiblePair = {
      pair,
      status: 'compatible',
      pathStyle: 'posix',
      normalizedRoot: '/comparison',
      coverage: { baseline: 'complete', target: 'complete' }
    }
    new ComparisonWorkspace(raw).prepare(compatibility, before.snapshot, after.snapshot)
    raw
      .prepare("UPDATE entries SET size_bytes = ? WHERE type = 'file'")
      .run(BigInt(Number.MAX_SAFE_INTEGER))
    expect(() =>
      prepareComparisonDirectories(raw, compatibility, before.scan, after.scan, undefined)
    ).toThrow(expect.objectContaining({ code: 'SIZE_OVERFLOW' }))
  }
)

test('retains one directory workspace, reuses historical validation and preserves the summary cache', () => {
  publish(db, fixture('before', [dir('old'), { key: 'old/report' }]))
  publish(db, fixture('after', [dir('new'), { key: 'new/report' }]))
  const matches = vi.spyOn(ComparisonWorkspace.prototype, 'prepare')
  const run = vi.spyOn(StatementSync.prototype, 'run')
  const get = vi.spyOn(StatementSync.prototype, 'get')
  const directAggregations = (): number =>
    run.mock.contexts.filter(
      (statement) =>
        statement instanceof StatementSync && statement.sourceSQL.includes('direct_file_kinds AS')
    ).length
  const validations = (): number =>
    get.mock.contexts.filter(
      (statement) =>
        statement instanceof StatementSync &&
        statement.sourceSQL.includes('WITH RECURSIVE reachable')
    ).length
  const initial = db.getComparisonSummary(pair)
  const checked = validations()
  const root = pages({ ...pair, includeRoot: true })[0]
  expect(root.subtreeFiles).toEqual(initial.files)
  expect(validations()).toBe(checked)
  expect(directAggregations()).toBe(1)
  publish(db, fixture('unrelated'))
  db.deleteSnapshot({ scanId: 'unrelated' })
  expect(db.listComparisonFileChanges(pair).totalCount).toBe(initial.files.totalCount)
  expect(db.getComparisonSummary(pair)).toBe(initial)
  expect(pages({ ...pair, sort: 'delta-asc' })).toHaveLength(2)
  expect(matches).toHaveBeenCalledTimes(1)
  expect(directAggregations()).toBe(1)
  expect(pages(reverse).map(({ kind }) => kind)).toEqual(['removed', 'added'])
  expect(pages(pair).map(({ kind }) => kind)).toEqual(['added', 'removed'])
  expect(matches).toHaveBeenCalledTimes(3)
  expect(directAggregations()).toBe(3)
})

test.each(['baselineScanId', 'targetScanId'] as const)(
  'invalidates cached directories after deletion of %s',
  (field) => {
    publish(db, fixture('before', [dir('old')]))
    publish(db, fixture('after', [dir('new')]))
    expect(pages(pair).map(({ relativePath }) => relativePath)).toEqual(['new', 'old'])
    db.deleteSnapshot({ scanId: pair[field] })
    expect(() => pages(pair)).toThrow(expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' }))
    publish(db, fixture(pair[field], [dir('replacement')]))
    expect(pages(pair).map(({ relativePath }) => relativePath)).toEqual([
      field === 'baselineScanId' ? 'new' : 'old',
      'replacement'
    ])
  }
)

test('rolls back failed directory preparation without losing a usable summary', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after', [dir('new')]))
  const initial = db.getComparisonSummary(pair)
  const original = StatementSync.prototype.run
  const stub = vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (
    this: StatementSync,
    ...args
  ) {
    if (this.sourceSQL.includes('direct_file_kinds AS')) throw new Error('integer overflow')
    return original.apply(this, args)
  })
  expect(() => pages(pair)).toThrow(expect.objectContaining({ code: 'SIZE_OVERFLOW' }))
  stub.mockRestore()
  expect(db.getComparisonSummary(pair)).toBe(initial)
  expect(pages(pair)).toMatchObject([{ relativePath: 'new', kind: 'added' }])
})

test('rejects unavailable and incompatible pairs', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after', [], { root: '/elsewhere' }))
  db.beginScan(fixture('running').building)
  for (const [targetScanId, code] of [
    ['after', 'INCOMPATIBLE_SNAPSHOTS'],
    ['before', 'INCOMPATIBLE_SNAPSHOTS'],
    ['running', 'SNAPSHOT_UNAVAILABLE'],
    ['missing', 'SNAPSHOT_EXPIRED']
  ]) {
    expect(() => pages({ ...pair, targetScanId })).toThrow(expect.objectContaining({ code }))
  }
})
