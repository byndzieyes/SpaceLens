// @vitest-environment node

import { StatementSync, type DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ComparisonWorkspace } from '../src/main/storage/comparisonWorkspace'
import type { CompatiblePair } from '../src/main/storage/comparisonMatchContracts'
import { readComparisonSummary } from '../src/main/storage/comparisonSummary'
import { ScanDatabase } from '../src/main/storage/database'
import { parseStorageResponse } from '../src/main/storage/workerProtocol'
import type { ComparisonFileChange, ComparisonFileSummary } from '../src/shared/comparison'
import { fixture, oracle, publish, type Spec } from './comparison-fixture'
import { createV1Database, seedV1Scan } from './v1-scan-fixture'

const pair = { baselineScanId: 'before', targetScanId: 'after' }
const reversed = { baselineScanId: 'after', targetScanId: 'before' }
const time = '2026-09-01T00:00:00.001Z'
const later = '2026-09-01T00:00:00.002Z'
const kinds = ['added', 'removed', 'modified', 'unchanged', 'indeterminate'] as const
const emptyCounts = { added: 0, removed: 0, modified: 0, unchanged: 0, indeterminate: 0 }
const emptyFiles = {
  counts: emptyCounts,
  totalCount: 0,
  knownDeltaCount: 0,
  unknownDeltaCount: 0,
  positiveDeltaBytes: 0,
  negativeDeltaBytes: 0,
  netKnownDeltaBytes: 0,
  confirmedKnownDeltaBytes: 0,
  confirmedUnknownDeltaCount: 0
}

let db: ScanDatabase
beforeEach(() => {
  db = new ScanDatabase(':memory:')
})
afterEach(() => db.close())

function expectedFiles(changes: readonly ComparisonFileChange[]): ComparisonFileSummary {
  const known = changes.flatMap(({ deltaBytes }) => (deltaBytes === null ? [] : [deltaBytes]))
  const sum = (values: readonly number[]): number =>
    values.reduce((total, bytes) => total + bytes, 0)
  const confirmed = changes.filter(({ kind }) => kind !== 'indeterminate')
  const counts = { ...emptyCounts }
  for (const { kind } of changes) counts[kind]++
  return {
    counts,
    totalCount: changes.length,
    knownDeltaCount: known.length,
    unknownDeltaCount: changes.length - known.length,
    positiveDeltaBytes: sum(known.filter((bytes) => bytes > 0)),
    negativeDeltaBytes: sum(known.filter((bytes) => bytes < 0)),
    netKnownDeltaBytes: sum(known),
    confirmedKnownDeltaBytes: sum(
      confirmed.flatMap(({ deltaBytes }) => (deltaBytes === null ? [] : [deltaBytes]))
    ),
    confirmedUnknownDeltaCount: confirmed.filter(({ deltaBytes }) => deltaBytes === null).length
  }
}

test.each([
  { entries: [] },
  {
    entries: [
      { key: 'folder', type: 'directory' },
      { key: 'link', type: 'symlink' }
    ]
  }
] satisfies Array<{ entries: Spec[] }>)(
  'returns explicit zero categories for snapshots with no files (case %#)',
  ({ entries }) => {
    const before = fixture('before', entries)
    const after = fixture('after', entries)
    publish(db, before)
    publish(db, after)
    expect(db.getComparisonSummary(pair)).toEqual({
      pair,
      compatibility: {
        pair,
        status: 'compatible',
        pathStyle: 'posix',
        normalizedRoot: '/comparison',
        coverage: { baseline: 'complete', target: 'complete' }
      },
      baseline: before.scan,
      target: after.scan,
      fileCountDelta: 0,
      directoryCountDelta: 0,
      observedSnapshotBytes: { baseline: 0, target: 0, delta: 0 },
      files: emptyFiles
    })
  }
)

test('counts identical files with distinct snapshot identities as known zero deltas', () => {
  const entries: Spec[] = [
    { key: 'a', sizeBytes: 25 },
    { key: 'b', sizeBytes: 0 }
  ]
  publish(db, fixture('before', entries))
  publish(db, fixture('after', entries))
  expect(db.getComparisonSummary(pair).files).toEqual({
    ...emptyFiles,
    counts: { ...emptyCounts, unchanged: 2 },
    totalCount: 2,
    knownDeltaCount: 2
  })
})

test('reverses all additions to removals, preserves zero-byte records, and counts the root', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const before = fixture('before')
  const after = fixture('after', [
    { key: 'directory', type: 'directory' },
    { key: 'directory/max', sizeBytes: maximum },
    { key: 'zero', sizeBytes: 0 }
  ])
  publish(db, before)
  publish(db, after)
  expect(db.getComparisonSummary(pair)).toMatchObject({
    baseline: { summary: { directoryCount: 1 } },
    target: { summary: { directoryCount: 2 } },
    fileCountDelta: 2,
    directoryCountDelta: 1,
    observedSnapshotBytes: { baseline: 0, target: maximum, delta: maximum },
    files: {
      ...emptyFiles,
      counts: { ...emptyCounts, added: 2 },
      totalCount: 2,
      knownDeltaCount: 2,
      positiveDeltaBytes: maximum,
      netKnownDeltaBytes: maximum,
      confirmedKnownDeltaBytes: maximum
    }
  })
  expect(db.getComparisonSummary(reversed)).toMatchObject({
    baseline: after.scan,
    target: before.scan,
    fileCountDelta: -2,
    directoryCountDelta: -1,
    observedSnapshotBytes: { baseline: maximum, target: 0, delta: -maximum },
    files: {
      ...emptyFiles,
      counts: { ...emptyCounts, removed: 2 },
      totalCount: 2,
      knownDeltaCount: 2,
      negativeDeltaBytes: -maximum,
      netKnownDeltaBytes: -maximum,
      confirmedKnownDeltaBytes: -maximum
    }
  })
})

test('preserves growth and reduction in a net-zero pair including a timestamp-only change', () => {
  const before = fixture('before', [
    { key: 'grow', sizeBytes: 2 },
    { key: 'shrink', sizeBytes: 7 },
    { key: 'time', sizeBytes: 3, modifiedAt: time }
  ])
  const after = fixture('after', [
    { key: 'grow', sizeBytes: 7 },
    { key: 'shrink', sizeBytes: 2 },
    { key: 'time', sizeBytes: 3, modifiedAt: later }
  ])
  publish(db, before)
  publish(db, after)
  expect(db.getComparisonSummary(pair)).toMatchObject({
    observedSnapshotBytes: { baseline: 12, target: 12, delta: 0 },
    files: {
      ...emptyFiles,
      counts: { ...emptyCounts, modified: 3 },
      totalCount: 3,
      knownDeltaCount: 3,
      positiveDeltaBytes: 5,
      negativeDeltaBytes: -5
    }
  })
})

test('preserves uncertainty independently of classification and stored logical-byte totals', () => {
  const before = fixture(
    'before',
    [
      { key: 'unknown-size', sizeBytes: null, modifiedAt: time },
      { key: 'indeterminate-time', sizeBytes: 4, modifiedAt: null },
      { key: 'dir-to-file', type: 'directory' },
      { key: 'dir-to-file/child', sizeBytes: 1 },
      { key: 'file-to-dir', sizeBytes: 5 }
    ],
    { errorCount: 2 }
  )
  const after = fixture('after', [
    { key: 'unknown-size', sizeBytes: 2, modifiedAt: later },
    { key: 'indeterminate-time', sizeBytes: 4, modifiedAt: null },
    { key: 'target-only', sizeBytes: 100 },
    { key: 'dir-to-file', sizeBytes: 8 },
    { key: 'file-to-dir', type: 'directory' }
  ])
  publish(db, before)
  publish(db, after)
  expect(db.getComparisonSummary(pair)).toMatchObject({
    compatibility: {
      status: 'compatible-with-warnings',
      warnings: [{ code: 'INCOMPLETE_COVERAGE', side: 'baseline' }]
    },
    observedSnapshotBytes: { baseline: 10, target: 114, delta: 104 },
    files: {
      counts: { added: 1, removed: 2, modified: 1, unchanged: 0, indeterminate: 2 },
      totalCount: 6,
      knownDeltaCount: 4,
      unknownDeltaCount: 2,
      positiveDeltaBytes: 8,
      negativeDeltaBytes: -6,
      netKnownDeltaBytes: 2,
      confirmedKnownDeltaBytes: 2,
      confirmedUnknownDeltaCount: 1
    }
  })
})

test('distinguishes all unknown contributions from known zero change', () => {
  publish(db, fixture('before', [{ key: 'old', sizeBytes: 3 }], { errorCount: 1 }))
  publish(db, fixture('after', [{ key: 'new', sizeBytes: 5 }], { errorCount: 1 }))
  expect(db.getComparisonSummary(pair)).toMatchObject({
    observedSnapshotBytes: { baseline: 3, target: 5, delta: 2 },
    files: {
      ...emptyFiles,
      counts: { ...emptyCounts, indeterminate: 2 },
      totalCount: 2,
      unknownDeltaCount: 2
    }
  })
})

function variants(partial: boolean): Array<Omit<Spec, 'key'> | null> {
  return [
    null,
    { sizeBytes: 0, modifiedAt: time },
    { sizeBytes: 2, modifiedAt: time },
    { sizeBytes: 2, modifiedAt: later },
    { sizeBytes: 6, modifiedAt: later },
    { sizeBytes: 2, modifiedAt: null },
    { type: 'directory' },
    { type: 'symlink' },
    { type: 'other' },
    ...(partial ? [{ type: 'unknown' as const }, { sizeBytes: null, modifiedAt: time }] : [])
  ]
}

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'matches the generated reference and every filtered page total with coverage %s / %s',
  (partialBefore, partialAfter) => {
    const left: Spec[] = []
    const right: Spec[] = []
    for (const [i, from] of variants(partialBefore).entries()) {
      for (const [j, to] of variants(partialAfter).entries()) {
        const key = 'entry-' + i + '-' + j
        if (from) left.push({ ...from, key })
        if (to) right.push({ ...to, key })
      }
    }
    const before = fixture('before', left, { errorCount: Number(partialBefore) })
    const after = fixture('after', right, { errorCount: Number(partialAfter) })
    publish(db, before)
    publish(db, after)
    const original = db.getComparisonSummary(pair)
    expect(original.files).toEqual(expectedFiles(oracle(before, after)))
    expect(original.compatibility.coverage).toEqual({
      baseline: partialBefore ? 'incomplete' : 'complete',
      target: partialAfter ? 'incomplete' : 'complete'
    })
    expect(original.baseline).toEqual(before.scan)
    expect(original.target).toEqual(after.scan)
    for (const kind of kinds) {
      expect(db.listComparisonFileChanges({ ...pair, kinds: [kind], limit: 1 }).totalCount).toBe(
        original.files.counts[kind]
      )
    }
    expect(db.listComparisonFileChanges({ ...pair, limit: 1 }).totalCount).toBe(
      original.files.totalCount
    )

    const reverse = db.getComparisonSummary(reversed)
    expect(reverse.files).toEqual(expectedFiles(oracle(after, before)))
    expect(reverse.files).toMatchObject({
      totalCount: original.files.totalCount,
      counts: {
        ...original.files.counts,
        added: original.files.counts.removed,
        removed: original.files.counts.added
      },
      knownDeltaCount: original.files.knownDeltaCount,
      unknownDeltaCount: original.files.unknownDeltaCount,
      positiveDeltaBytes: Math.abs(original.files.negativeDeltaBytes),
      negativeDeltaBytes: 0 - original.files.positiveDeltaBytes,
      netKnownDeltaBytes: 0 - original.files.netKnownDeltaBytes
    })
    expect(reverse.compatibility.coverage).toEqual({
      baseline: original.compatibility.coverage.target,
      target: original.compatibility.coverage.baseline
    })
    expect(reverse.observedSnapshotBytes.delta).toBe(0 - original.observedSnapshotBytes.delta)
    expect(reverse.fileCountDelta).toBe(0 - original.fileCountDelta)
    expect(reverse.directoryCountDelta).toBe(0 - original.directoryCountDelta)
  }
)

function withRawPair(
  count: number,
  operation: (
    connection: DatabaseSync,
    read: () => ReturnType<typeof readComparisonSummary>
  ) => void
): void {
  using connection = createV1Database(':memory:')
  const workspace = new ComparisonWorkspace(connection)
  const before = fixture('before')
  const after = fixture(
    'after',
    Array.from({ length: count }, (_, i) => ({ key: 'file-' + i }))
  )
  seedV1Scan(connection, before.scan, before.entries)
  seedV1Scan(connection, after.scan, after.entries)
  const compatible: CompatiblePair = {
    pair,
    status: 'compatible',
    pathStyle: 'posix',
    normalizedRoot: '/comparison',
    coverage: { baseline: 'complete', target: 'complete' }
  }
  workspace.prepare(compatible, before.snapshot, after.snapshot)
  operation(connection, () =>
    readComparisonSummary(connection, compatible, before.scan, after.scan)
  )
}

test.each([
  [1, 9_007_199_254_740_992n],
  [2, BigInt(Number.MAX_SAFE_INTEGER)],
  [1025, BigInt(Number.MAX_SAFE_INTEGER)]
] as const)('rejects unsafe individual and aggregate byte values (%s entries)', (count, value) => {
  withRawPair(count, (connection, read) => {
    connection.prepare("UPDATE entries SET size_bytes = ? WHERE type = 'file'").run(value)
    expect(read).toThrow(expect.objectContaining({ code: 'SIZE_OVERFLOW' }))
  })
})

test('rejects an inconsistent complete-byte reconciliation', () => {
  withRawPair(1, (connection, read) => {
    connection.exec("UPDATE entries SET size_bytes = 0 WHERE type = 'file'")
    expect(read).toThrow('Inconsistent comparison summary.')
  })
})

test('reuses historical validation and the cached count only for unfiltered pages', () => {
  publish(db, fixture('before', [{ key: 'old' }]))
  publish(db, fixture('after', [{ key: 'folder', type: 'directory' }, { key: 'folder/new' }]))
  const prepare = vi.spyOn(ComparisonWorkspace.prototype, 'prepare')
  const all = vi.spyOn(StatementSync.prototype, 'all')
  const get = vi.spyOn(StatementSync.prototype, 'get')
  const summaries = (): number =>
    all.mock.contexts.filter(
      (statement) =>
        statement instanceof StatementSync && statement.sourceSQL.includes('GROUP BY kind')
    ).length
  const counts = (): number =>
    get.mock.contexts.filter(
      (statement) =>
        statement instanceof StatementSync &&
        statement.sourceSQL.includes('SELECT COUNT(*) AS total FROM file_changes')
    ).length
  const integrityChecks = (): number =>
    get.mock.contexts.filter(
      (statement) =>
        statement instanceof StatementSync &&
        statement.sourceSQL.includes('WITH RECURSIVE reachable')
    ).length
  expect(db.listComparisonFileChanges({ ...pair, limit: 1 }).totalCount).toBe(2)
  expect(counts()).toBe(1)
  const summary = db.getComparisonSummary(pair)
  expect(summaries()).toBe(1)
  const initialChecks = integrityChecks()
  expect(initialChecks).toBeGreaterThan(0)
  expect(db.getComparisonSummary(pair)).toEqual(summary)
  expect(db.listComparisonFileChanges({ ...pair, limit: 1, sort: 'delta-desc' }).totalCount).toBe(2)
  expect(db.listComparisonFileChanges({ ...pair, offset: 1 }).items).toHaveLength(1)
  expect(counts()).toBe(1)
  expect(db.listComparisonFileChanges({ ...pair, kinds: ['added'] }).totalCount).toBe(1)
  expect(db.listComparisonFileChanges({ ...pair, relativeDirectory: 'folder' }).totalCount).toBe(1)
  expect(counts()).toBe(3)
  publish(db, fixture('unrelated'))
  db.deleteSnapshot({ scanId: 'unrelated' })
  expect(db.getComparisonSummary(pair)).toEqual(summary)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(summaries()).toBe(1)
  const afterPublicationChecks = integrityChecks()
  expect(db.getComparisonSummary(reversed).pair).toEqual(reversed)
  expect(integrityChecks()).toBe(afterPublicationChecks)
  expect(db.getComparisonSummary(pair)).toEqual(summary)
  expect(prepare).toHaveBeenCalledTimes(3)
  expect(summaries()).toBe(3)
})

test('never caches a failed aggregate and rebuilds after rollback', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after', [{ key: 'new' }]))
  const prepare = vi.spyOn(ComparisonWorkspace.prototype, 'prepare')
  const original = StatementSync.prototype.all
  const stub = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (
    this: StatementSync,
    ...args
  ) {
    if (this.sourceSQL.includes('GROUP BY kind')) throw new Error('integer overflow')
    return original.apply(this, args)
  })
  expect(() => db.getComparisonSummary(pair)).toThrow(
    expect.objectContaining({ code: 'SIZE_OVERFLOW' })
  )
  stub.mockRestore()
  const summary = db.getComparisonSummary(pair)
  expect(summary.files).toMatchObject({ totalCount: 1, knownDeltaCount: 1, positiveDeltaBytes: 1 })
  expect(db.getComparisonSummary(pair)).toEqual(summary)
  expect(prepare).toHaveBeenCalledTimes(2)
})

test.each(['baselineScanId', 'targetScanId'] as const)(
  'invalidates the cached summary when %s is deleted',
  (field) => {
    publish(db, fixture('before'))
    publish(db, fixture('after', [{ key: 'new' }]))
    const initial = db.getComparisonSummary(pair)
    db.deleteSnapshot({ scanId: pair[field] })
    expect(() => db.getComparisonSummary(pair)).toThrow(
      expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
    )
    publish(db, fixture(pair[field], [{ key: 'replacement', sizeBytes: 13 }]))
    const replacement = db.getComparisonSummary(pair)
    expect(replacement).not.toEqual(initial)
    expect(replacement.files.netKnownDeltaBytes).toBe(field === 'baselineScanId' ? -12 : 13)
  }
)

test('rejects invalid, running and incompatible pairs', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after', [], { root: '/other' }))
  db.beginScan(fixture('active').building)
  for (const [request, code] of [
    [pair, 'INCOMPATIBLE_SNAPSHOTS'],
    [{ ...pair, targetScanId: 'before' }, 'INCOMPATIBLE_SNAPSHOTS'],
    [{ ...pair, targetScanId: 'active' }, 'SNAPSHOT_UNAVAILABLE'],
    [{ ...pair, targetScanId: 'missing' }, 'SNAPSHOT_EXPIRED'],
    [{ ...pair, targetScanId: '../other' }, 'INVALID_REQUEST'],
    [{ ...pair, limit: 1 }, 'INVALID_REQUEST']
  ] as const) {
    expect(() => db.getComparisonSummary(request)).toThrow(expect.objectContaining({ code }))
  }
})

test('rejects malformed Worker results with inconsistent counts, bytes or identity', () => {
  publish(db, fixture('before'))
  publish(db, fixture('after', [{ key: 'new' }]))
  const result = db.getComparisonSummary(pair)
  const response = { requestId: 1, ok: true, result }
  expect(parseStorageResponse(response, 1, 'getComparisonSummary')).toEqual(response)
  for (const fields of [
    { totalCount: 2 },
    { unknownDeltaCount: 1 },
    { negativeDeltaBytes: 1 },
    { netKnownDeltaBytes: 0 },
    { confirmedKnownDeltaBytes: 2 },
    { positiveDeltaBytes: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    expect(() =>
      parseStorageResponse(
        {
          ...response,
          result: { ...result, files: { ...result.files, ...fields } }
        },
        1,
        'getComparisonSummary'
      )
    ).toThrow()
  }
  expect(() =>
    parseStorageResponse(
      {
        ...response,
        result: { ...result, baseline: result.target }
      },
      1,
      'getComparisonSummary'
    )
  ).toThrow()
})
