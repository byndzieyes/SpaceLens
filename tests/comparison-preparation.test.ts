// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import type {
  ComparisonPreparationRequest,
  ComparisonPreparationStatus
} from '../src/main/storage/comparisonPreparation'
import type { ComparisonPair } from '../src/shared/comparison'
import { fixture } from './comparison-fixture'

const pair: ComparisonPair = { baselineScanId: 'a', targetScanId: 'b' }
const reversed: ComparisonPair = { baselineScanId: 'b', targetScanId: 'a' }
const stale = expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' })
const privateWorkspace = expect.objectContaining({ code: 'SNAPSHOT_UNAVAILABLE' })

function runStages(
  db: ScanDatabase,
  request: ComparisonPreparationRequest,
  initial: ComparisonPreparationStatus
): ComparisonPreparationStatus[] {
  const updates = [initial]
  let status = initial
  while (status.phase !== 'ready') {
    const next = db.prepareComparisonWorkspace({ ...request, action: 'advance' })
    expect(next.completed).toBe(status.completed + 1)
    status = next
    updates.push(status)
    expect(updates.length).toBeLessThan(100)
    expect(db.listScanHistory({ limit: 1 }).latestCompletedScanId).toBe('latest')
  }
  return updates
}

function request(
  source: ComparisonPair,
  scope: ComparisonPreparationRequest['scope'] = 'workspace'
): ComparisonPreparationRequest {
  return { pair: source, id: randomUUID(), scope, action: 'start' }
}

function seed(db: ScanDatabase): void {
  // One transaction keeps the fixture independent of the CI filesystem's commit latency.
  db.transaction(() => {
    for (const { scan, entries } of [
      fixture('a', [
        { key: 'nested', type: 'directory' },
        ...Array.from({ length: 4200 }, (_, n) => ({ key: 'nested/item-' + n, sizeBytes: n })),
        { key: 'empty-a', type: 'directory' },
        { key: 'as-directory', sizeBytes: 0 }
      ]),
      fixture(
        'b',
        [
          { key: 'nested', type: 'directory' },
          ...Array.from({ length: 4200 }, (_, n) => ({
            key: 'nested/item-' + (n + 2),
            sizeBytes: n % 9 === 0 ? null : n
          })),
          { key: 'empty-b', type: 'directory' },
          { key: 'as-directory', type: 'directory' }
        ],
        { errorCount: 1 }
      ),
      fixture('latest')
    ]) {
      db.insertScan(scan)
      for (const entry of entries) db.insertEntry(entry)
    }
  })
}

test('keeps a directional candidate private and matches the reference summary and detail queries', () => {
  const db = new ScanDatabase(':memory:')
  try {
    seed(db)
    const files = { ...pair, relativeDirectory: 'nested', sort: 'delta-asc', offset: 23, limit: 50 }
    const dirs = { ...pair, includeRoot: true, limit: 20 }
    const expectedSummary = db.getComparisonSummary(pair)
    const expectedFiles = db.listComparisonFileChanges(files)
    const expectedDirectories = db.listComparisonDirectoryChanges(dirs)
    const first = request(reversed)
    runStages(db, first, db.prepareComparisonWorkspace(first))
    const previous = db.getComparisonSummary(reversed)

    const replacement = request(pair)
    const started = db.prepareComparisonWorkspace(replacement)
    expect(started.phase).toBe('matching')
    expect(() => db.getComparisonSummary(pair)).toThrow(privateWorkspace)
    expect(db.getComparisonSummary(reversed)).toEqual(previous)
    expect(() =>
      db.prepareComparisonWorkspace({ ...replacement, action: 'advance', pair: reversed })
    ).toThrow(stale)
    expect(() => db.prepareComparisonWorkspace(replacement)).toThrow(privateWorkspace)
    const updates = runStages(db, replacement, started)
    expect(updates.filter((status) => status.phase === 'matching').length).toBeGreaterThan(3)
    expect(updates.some((status) => status.phase === 'classifying')).toBe(true)
    expect(db.getComparisonSummary(pair)).toEqual(expectedSummary)
    expect(db.listComparisonFileChanges(files)).toEqual(expectedFiles)

    const directory = request(pair, 'directories')
    const building = db.prepareComparisonWorkspace(directory)
    expect(building.phase).toBe('directories')
    expect(() => db.listComparisonDirectoryChanges(dirs)).toThrow(privateWorkspace)
    expect(() => db.prepareComparisonWorkspace(request(reversed))).toThrow(privateWorkspace)
    expect(db.getComparisonSummary(pair)).toEqual(expectedSummary)
    runStages(db, directory, building)
    expect(db.listComparisonDirectoryChanges(dirs)).toEqual(expectedDirectories)
    db.prepareComparisonWorkspace({ ...first, action: 'discard' })
    expect(db.getComparisonSummary(pair)).toEqual(expectedSummary)
  } finally {
    db.close()
  }
})

test('abandons intermediate state, rejects stale stages, and invalidates a deleted source', () => {
  const db = new ScanDatabase(':memory:')
  try {
    seed(db)
    const first = request(pair)
    db.prepareComparisonWorkspace(first)
    db.prepareComparisonWorkspace({ ...first, action: 'advance' })
    db.prepareComparisonWorkspace({ ...first, action: 'discard' })
    const second = request(pair)
    const status = db.prepareComparisonWorkspace(second)
    expect(() => db.prepareComparisonWorkspace({ ...first, action: 'advance' })).toThrow(stale)
    db.prepareComparisonWorkspace({ ...first, action: 'discard' })
    runStages(db, second, status)
    const directory = request(pair, 'directories')
    db.prepareComparisonWorkspace(directory)
    db.prepareComparisonWorkspace({ ...directory, action: 'advance' })
    db.prepareComparisonWorkspace({ ...directory, action: 'discard' })
    const retry = request(pair, 'directories')
    runStages(db, retry, db.prepareComparisonWorkspace(retry))
    expect(
      db.listComparisonDirectoryChanges({ ...pair, includeRoot: true }).items.length
    ).toBeGreaterThan(0)

    const third = request(reversed)
    db.prepareComparisonWorkspace(third)
    db.deleteSnapshot({ scanId: 'a' })
    expect(() => db.prepareComparisonWorkspace({ ...third, action: 'advance' })).toThrow(stale)
    expect(() => db.prepareComparisonWorkspace(request(reversed))).toThrow(stale)
  } finally {
    db.close()
  }
})
