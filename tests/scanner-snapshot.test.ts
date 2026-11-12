// @vitest-environment node
import { expect, test } from 'vitest'
import { resolve } from 'node:path'
import { ScanSnapshotStorage, validateSnapshotRequest } from '../src/main/scanner/snapshot'
import type { FileEntry } from '../src/shared/scan'
import type { ScanDirectoryRequest } from '../src/shared/snapshot'
import type { ScanSummaryEvent } from '../src/main/scanner/summary'

const path = resolve('snapshot-fixture')
const timestamp = '2026-11-12T12:00:00.000Z'
function entry(
  id: string,
  parentId: string | null = null,
  type: FileEntry['type'] = 'directory',
  sizeBytes: number | null = null
): FileEntry {
  return {
    id,
    scanId: 'scan',
    parentId,
    path: parentId === null ? path : resolve(path, id),
    name: id,
    type,
    sizeBytes,
    aggregatedSizeBytes: null,
    createdAt: null,
    modifiedAt: null
  }
}
function finalized(storage: ScanSnapshotStorage, directory: FileEntry, bytes: number): void {
  storage.accept({
    type: 'directory-finalized',
    entry: { ...directory, aggregatedSizeBytes: bytes }
  })
}
function summary(
  fileCount = 0,
  directoryCount = 1,
  totalBytes = 0,
  errorCount = 0
): ScanSummaryEvent {
  return {
    type: 'summary',
    scanId: 'scan',
    rootEntryId: 'root',
    summary: { fileCount, directoryCount, totalBytes, errorCount }
  }
}
function request(entryId = 'root', offset = 0, limit = 100): ScanDirectoryRequest {
  return { scanId: 'scan', entryId, offset, limit }
}

test('retains an empty root, publishes only finalized data, and isolates all returned records', () => {
  const store = new ScanSnapshotStorage('scan', path)
  const root = entry('root')
  store.accept({ type: 'entry', entry: root })
  expect(() => store.describe()).toThrow('unavailable')
  finalized(store, root, 0)
  expect(store.complete(summary(), timestamp)).toBe(true)
  expect(store.describe()).toMatchObject({
    entries: { scanId: 'scan', rootEntryId: 'root' },
    root: { sizeBytes: null, aggregatedSizeBytes: 0 },
    entryCount: 1,
    incomplete: false
  })
  expect(store.listDirectory(request())).toEqual({
    scanId: 'scan',
    directoryId: 'root',
    entries: [],
    totalCount: 0,
    nextOffset: null
  })
  Object.assign(store.describe().root, { path: 'mutated' })
  Object.assign(store.describe().summary, { totalBytes: 999 })
  Object.assign(store.getEntry('root'), { aggregatedSizeBytes: 999 })
  store.accept({ type: 'entry', entry: entry('late', 'root', 'file', 2) })
  expect(store.describe().root.path).toBe(path)
  expect(store.describe().summary.totalBytes).toBe(0)
  expect(store.getEntry('root').aggregatedSizeBytes).toBe(0)
  expect(() => store.getEntry('late')).toThrow('does not exist')
})

test('indexes direct children and nested totals with deterministic pages and tie breaking', () => {
  const store = new ScanSnapshotStorage('scan', path)
  const root = entry('root')
  const nested = entry('nested', 'root')
  const files = [
    entry('z', 'root', 'file', 2),
    entry('b', 'root', 'file', 3),
    entry('a', 'root', 'file', 4)
  ]
  const descendant = entry('deep', 'nested', 'file', 6)
  for (const item of [root, ...files, nested, descendant])
    store.accept({ type: 'entry', entry: item })
  // A consumer cannot mutate the builder through the original event reference.
  Object.assign(files[0], { sizeBytes: 999 })
  finalized(store, nested, 6)
  finalized(store, root, 15)
  expect(store.complete(summary(4, 2, 15), timestamp)).toBe(true)
  const first = store.listDirectory(request('root', 0, 2))
  expect(first.entries.map((item) => item.id)).toEqual(['a', 'b'])
  expect(first.nextOffset).toBe(2)
  expect(first.totalCount).toBe(4)
  expect(store.listDirectory(request('root', 2, 2)).entries.map((item) => item.id)).toEqual([
    'nested',
    'z'
  ])
  expect(store.listDirectory(request('root', 2, 2)).nextOffset).toBeNull()
  expect(store.listDirectory(request('root', 4, 2)).entries).toEqual([])
  expect(store.listDirectory(request('root', Number.MAX_SAFE_INTEGER)).entries).toEqual([])
  expect(store.listDirectory(request('nested')).entries).toEqual([descendant])
  expect(store.getEntry('nested').aggregatedSizeBytes).toBe(6)
  expect(store.getEntry('z').sizeBytes).toBe(2)
  Object.assign(first.entries[0], { name: 'changed' })
  expect(store.getEntry('a').name).toBe('a')
  expect(() => store.listDirectory(request('a'))).toThrow('not a directory')
  expect(() => store.getEntry('missing')).toThrow('does not exist')
})

test('orders equal names by ID and UTF-16 names independently of locale', () => {
  const store = new ScanSnapshotStorage('scan', path)
  const root = entry('root')
  store.accept({ type: 'entry', entry: root })
  for (const [id, name] of [
    ['b', 'same'],
    ['a', 'same'],
    ['c', 'Я'],
    ['d', 'A']
  ]) {
    store.accept({ type: 'entry', entry: { ...entry(id, 'root', 'file', 0), name } })
  }
  finalized(store, root, 0)
  expect(store.complete(summary(4), timestamp)).toBe(true)
  expect(store.listDirectory(request()).entries.map((item) => item.id)).toEqual([
    'd',
    'a',
    'b',
    'c'
  ])
})

test('retains known bytes and nullable metadata with explicit incompleteness after recoverable errors', () => {
  const store = new ScanSnapshotStorage('scan', path)
  const root = entry('root')
  for (const item of [
    root,
    entry('first', 'root', 'file', 100_000_000),
    entry('second', 'root', 'file', 200_000_000),
    entry('private', 'root', 'unknown'),
    entry('link', 'root', 'symlink')
  ])
    store.accept({ type: 'entry', entry: item })
  store.accept({
    type: 'error',
    error: { path: resolve(path, 'private'), code: 'EACCES', message: 'Access denied' }
  })
  finalized(store, root, 300_000_000)
  expect(store.complete(summary(2, 1, 300_000_000, 1), timestamp)).toBe(true)
  expect(store.describe()).toMatchObject({
    incomplete: true,
    summary: { totalBytes: 300_000_000, errorCount: 1 }
  })
  expect(store.getEntry('private')).toMatchObject({
    type: 'unknown',
    sizeBytes: null,
    createdAt: null,
    modifiedAt: null
  })
})

test.each([
  [
    'duplicate ID',
    (store: ScanSnapshotStorage) => store.accept({ type: 'entry', entry: entry('root') })
  ],
  [
    'missing parent',
    (store: ScanSnapshotStorage) =>
      store.accept({ type: 'entry', entry: entry('child', 'missing') })
  ],
  [
    'foreign scan',
    (store: ScanSnapshotStorage) =>
      store.accept({ type: 'entry', entry: { ...entry('child', 'root'), scanId: 'foreign' } })
  ],
  [
    'non-directory parent',
    (store: ScanSnapshotStorage) => {
      store.accept({ type: 'entry', entry: entry('file', 'root', 'file', 0) })
      store.accept({ type: 'entry', entry: entry('child', 'file') })
    }
  ],
  [
    'unknown finalization',
    (store: ScanSnapshotStorage) => finalized(store, entry('missing', 'root'), 0)
  ],
  [
    'changed finalization identity',
    (store: ScanSnapshotStorage) => finalized(store, { ...entry('root'), path: 'different' }, 0)
  ],
  [
    'premature parent finalization',
    (store: ScanSnapshotStorage) => {
      store.accept({ type: 'entry', entry: entry('child', 'root') })
      finalized(store, entry('root'), 0)
    }
  ],
  [
    'duplicate finalization',
    (store: ScanSnapshotStorage) => {
      finalized(store, entry('root'), 0)
      finalized(store, entry('root'), 0)
    }
  ],
  [
    'discovery after parent finalization',
    (store: ScanSnapshotStorage) => {
      finalized(store, entry('root'), 0)
      store.accept({ type: 'entry', entry: entry('late', 'root') })
    }
  ],
  [
    'invalid directory size',
    (store: ScanSnapshotStorage) =>
      store.accept({ type: 'entry', entry: entry('child', 'root', 'directory', 1) })
  ],
  [
    'unsafe size',
    (store: ScanSnapshotStorage) =>
      store.accept({
        type: 'entry',
        entry: entry('file', 'root', 'file', Number.MAX_SAFE_INTEGER + 1)
      })
  ],
  ['incorrect aggregation', (store: ScanSnapshotStorage) => finalized(store, entry('root'), 1)]
])('rejects %s without exposing partial storage', (_name, corrupt) => {
  const store = new ScanSnapshotStorage('scan', path)
  store.accept({ type: 'entry', entry: entry('root') })
  corrupt(store)
  expect(store.unavailableReason).toBe('invalid-data')
  expect(store.complete(summary(), timestamp)).toBe(false)
  expect(() => store.describe()).toThrow('unavailable')
})

test.each([
  { maxEntries: 1, maxEstimatedBytes: 1_000_000 },
  { maxEntries: 100, maxEstimatedBytes: 1 }
])('discards storage explicitly on a retention limit: %o', (limits) => {
  const store = new ScanSnapshotStorage('scan', path, limits)
  store.accept({ type: 'entry', entry: entry('root') })
  store.accept({ type: 'entry', entry: entry('file', 'root', 'file', 1) })
  finalized(store, entry('root'), 1)
  expect(store.unavailableReason).toBe('limit-exceeded')
  expect(store.complete(summary(1, 1, 1), timestamp)).toBe(false)
  expect(() => store.describe()).toThrow('unavailable')
})

test('caps individual records for bounded IPC responses', () => {
  const store = new ScanSnapshotStorage('scan', path)
  store.accept({ type: 'entry', entry: { ...entry('root'), name: 'x'.repeat(40_000) } })
  expect(store.unavailableReason).toBe('limit-exceeded')
})

test.each([
  { scanId: 'foreign' },
  { rootEntryId: 'missing' },
  { summary: { fileCount: 2, directoryCount: 1, totalBytes: 0, errorCount: 0 } }
])('rejects completion whose identity or counters differ: %o', (change) => {
  const store = new ScanSnapshotStorage('scan', path)
  store.accept({ type: 'entry', entry: entry('root') })
  finalized(store, entry('root'), 0)
  expect(store.complete({ ...summary(), ...change }, timestamp)).toBe(false)
})

test('requires finalization and errors for unknown metadata', () => {
  const store = new ScanSnapshotStorage('scan', path)
  store.accept({ type: 'entry', entry: entry('root') })
  expect(store.complete(summary(), timestamp)).toBe(false)
  const unknown = new ScanSnapshotStorage('scan', path)
  unknown.accept({ type: 'entry', entry: entry('root') })
  unknown.accept({ type: 'entry', entry: entry('file', 'root', 'file') })
  finalized(unknown, entry('root'), 0)
  expect(unknown.complete(summary(1), timestamp)).toBe(false)
})

test.each([
  null,
  [],
  {},
  { ...request(), extra: true },
  { ...request(), scanId: '' },
  { ...request(), entryId: '../file' },
  { ...request(), scanId: 'a'.repeat(129) },
  ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((offset) => ({
    ...request(),
    offset
  })),
  ...[0, -1, 101, 1.1, NaN, '5'].map((limit) => ({ ...request(), limit }))
])('validates retrieval arguments: %o', (invalid) => {
  expect(() => validateSnapshotRequest(invalid as ScanDirectoryRequest, true)).toThrow(
    'Valid snapshot IDs'
  )
})

test('accepts bounded requests and rejects pagination on single-entry requests', () => {
  expect(() => validateSnapshotRequest(request(), true)).not.toThrow()
  expect(() => validateSnapshotRequest({ scanId: 'scan', entryId: 'root' }, false)).not.toThrow()
  expect(() => validateSnapshotRequest(request(), false)).toThrow('Valid snapshot IDs')
})
