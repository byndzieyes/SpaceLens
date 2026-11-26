// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToStorage } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { afterEach, beforeEach, expect, test, vi, type MockedFunction } from 'vitest'
import { registerScannerIpc } from '../src/main/scannerIpc'
import { MAX_QUEUED_EXPLORER_READS, ScanStorageCoordinator } from '../src/main/storage/coordinator'
import { ScanDatabase } from '../src/main/storage/database'
import { HistoryRetention } from '../src/main/storage/historyRetention'
import { RetentionSettingsStore } from '../src/main/storage/retentionSettings'
import {
  STORAGE_REQUEST_TIMEOUT_MS,
  StorageWorkerError,
  type StorageWorkerClient
} from '../src/main/storage/workerClient'
import type {
  AdoptedComparisonSelection,
  ComparisonErrorCode,
  ComparisonPair,
  PreparedComparisonSelection
} from '../src/shared/comparison'
import {
  IPC_CHANNELS,
  type ComparisonAPI,
  type ScannerIpcErrorCode,
  type ScannerIpcResult
} from '../src/shared/ipc'
import type {
  PreparedSnapshotSelection,
  SnapshotSelectionAdoption,
  SnapshotView
} from '../src/shared/snapshotSelection'
import { fixture, publish } from './comparison-fixture'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
    app: {},
    BrowserWindow: {},
    dialog: {}
  }
})

const pair: ComparisonPair = { baselineScanId: 'a', targetScanId: 'b' }
const replacement: ComparisonPair = { baselineScanId: 'c', targetScanId: 'd' }
const reversed: ComparisonPair = { baselineScanId: 'b', targetScanId: 'a' }
const url = 'file:///comparison/index.html'

type FixtureResult<Value> = ScannerIpcResult<Value, ScannerIpcErrorCode | ComparisonErrorCode>
type WorkerMocks = {
  [
    K in
      | 'applyBatch'
      | 'getScan'
      | 'requireValidatedScan'
      | 'getComparisonSummary'
      | 'listComparisonFileChanges'
      | 'listComparisonDirectoryChanges'
  ]: MockedFunction<StorageWorkerClient[K]>
}

interface ComparisonFixture {
  api<K extends keyof ComparisonAPI>(
    method: K,
    request: Parameters<ComparisonAPI[K]>[0]
  ): ReturnType<ComparisonAPI[K]>
  ipc<Value = unknown>(
    method: keyof typeof IPC_CHANNELS,
    ...args: unknown[]
  ): Promise<FixtureResult<Value>>
  prepared(pair: ComparisonPair): Promise<PreparedComparisonSelection>
  adopt(pair: ComparisonPair): Promise<AdoptedComparisonSelection>
  protectedIds(...ids: string[]): string[]
  worker: WorkerMocks & { isReady: boolean }
  storage: ScanStorageCoordinator
  renderer: EventEmitter
  event: IpcMainInvokeEvent
  db: ScanDatabase
  databasePath: string
  exit: ReturnType<typeof Promise.withResolvers<void>>
  retention: HistoryRetention
  boundary: ReturnType<typeof registerScannerIpc>
  close(): Promise<void>
}

function createFixture(): ComparisonFixture {
  const working = mkdtempSync(join(tmpdir(), 'spacelens-comparison-ipc-'))
  const databasePath = join(working, 'saved.sqlite')
  const db = new ScanDatabase(databasePath)
  const exit = Promise.withResolvers<void>()
  const worker = {
    isReady: true,
    waitForExit: () => exit.promise,
    getScan: vi.fn(async (id: string) => db.getScan(id)),
    requireValidatedScan: vi.fn(async (id: string) => db.requireValidatedScan(id)),
    getComparisonSummary: vi.fn(async (pair: ComparisonPair) => db.getComparisonSummary(pair)),
    listComparisonFileChanges: vi.fn<StorageWorkerClient['listComparisonFileChanges']>(
      async (query) => db.listComparisonFileChanges(query)
    ),
    listComparisonDirectoryChanges: vi.fn<StorageWorkerClient['listComparisonDirectoryChanges']>(
      async (query) => db.listComparisonDirectoryChanges(query)
    ),
    getScanHistoryMetadata: async (request: unknown) => db.getScanHistoryMetadata(request),
    openSavedSnapshot: async (request: string) => db.openSavedSnapshot({ scanId: request }),
    deleteSnapshot: vi.fn<StorageWorkerClient['deleteSnapshot']>(async (request) =>
      db.deleteSnapshot(request)
    ),
    getRetentionCandidate: vi.fn<StorageWorkerClient['getRetentionCandidate']>(async (request) =>
      db.getRetentionCandidate(request)
    ),
    pruneSnapshot: async (request: Parameters<StorageWorkerClient['pruneSnapshot']>[0]) =>
      db.pruneSnapshot(request),
    beginScan: vi.fn<StorageWorkerClient['beginScan']>(async (scan) => db.beginScan(scan)),
    discardBuildingScan: vi.fn<StorageWorkerClient['discardBuildingScan']>(async (scanId) =>
      db.discardBuildingScan(scanId)
    ),
    applyBatch: vi.fn<StorageWorkerClient['applyBatch']>(async (scanId, entries) =>
      db.applyBatch(scanId, entries)
    )
  }
  const storage = new ScanStorageCoordinator(
    Promise.resolve(worker as unknown as StorageWorkerClient)
  )
  const settings = new RetentionSettingsStore(join(working, 'retention.json'))
  const retention = new HistoryRetention(storage, settings)
  const boundary = registerScannerIpc(
    {
      getState: () => null,
      subscribe: () => () => {},
      dispose: async () => {}
    } as unknown as Parameters<typeof registerScannerIpc>[0],
    url,
    storage,
    Promise.resolve(null),
    retention
  )
  const renderer = Object.assign(new EventEmitter(), {
    mainFrame: { url },
    isDestroyed: () => false,
    send: vi.fn()
  })
  boundary.attachRenderer(renderer as unknown as WebContents)
  const event = {
    sender: renderer,
    senderFrame: renderer.mainFrame
  } as unknown as IpcMainInvokeEvent
  const ipc: ComparisonFixture['ipc'] = <Value>(
    method: keyof typeof IPC_CHANNELS,
    ...args: unknown[]
  ): Promise<FixtureResult<Value>> => {
    const handle = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === IPC_CHANNELS[method])?.[1]
    if (!handle) throw new Error('No handler registered.')
    return handle(event, ...args) as Promise<FixtureResult<Value>>
  }
  const api = <K extends keyof ComparisonAPI>(
    method: K,
    request: Parameters<ComparisonAPI[K]>[0]
  ): ReturnType<ComparisonAPI[K]> => ipc(method, request) as ReturnType<ComparisonAPI[K]>
  const prepared = async (pair: ComparisonPair): Promise<PreparedComparisonSelection> =>
    success(await api('prepareComparisonSelection', pair))
  const adopt = async (pair: ComparisonPair): Promise<AdoptedComparisonSelection> => {
    const { ticket } = await prepared(pair)
    return success(await api('adoptComparisonSelection', { ticket }))
  }
  const protectedIds = (...ids: string[]): string[] =>
    ids.filter((id) => storage.isSnapshotProtected(id))
  const close = async (): Promise<void> => {
    await boundary.dispose()
    await retention.stop()
    db.close()
    rmSync(working, { recursive: true, force: true })
  }
  publish(
    db,
    fixture('a', [
      { key: 'sub', type: 'directory' },
      { key: 'sub/change', sizeBytes: 4 }
    ])
  )
  publish(
    db,
    fixture(
      'b',
      [
        { key: 'sub', type: 'directory' },
        { key: 'sub/change', sizeBytes: 10 }
      ],
      { errorCount: 1 }
    )
  )
  publish(db, fixture('c'))
  publish(db, fixture('d'))
  return {
    api,
    ipc,
    prepared,
    adopt,
    protectedIds,
    worker,
    storage,
    renderer,
    event,
    db,
    databasePath,
    exit,
    retention,
    boundary,
    close
  }
}

function success<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`Unexpected error ${result.error.code}`)
  return result.value
}

let app: ComparisonFixture
beforeEach(() => {
  vi.clearAllMocks()
  app = createFixture()
})
afterEach(async () => {
  vi.useRealTimers()
  await app.close()
})

test('evaluates exact compatibility with only temporary leases and without analytics authority', async () => {
  const result = await app.api('evaluateComparisonCompatibility', pair)
  expect(result).toMatchObject({
    ok: true,
    value: {
      pair,
      status: 'compatible-with-warnings',
      warnings: [{ code: 'INCOMPLETE_COVERAGE', side: 'target' }]
    }
  })
  expect(app.protectedIds('a', 'b')).toEqual([])
  expect(app.worker.requireValidatedScan).not.toHaveBeenCalled()
  expect(app.worker.getComparisonSummary).not.toHaveBeenCalled()
  await expect(
    app.api('getComparisonSummary', { selectionId: randomUUID(), query: pair })
  ).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_UNAVAILABLE' } })
  app.worker.getScan.mockClear()
  await expect(
    app.api('evaluateComparisonCompatibility', { ...pair, targetScanId: 'a' })
  ).resolves.toMatchObject({ ok: true, value: { reason: { code: 'SAME_SNAPSHOT' } } })
  expect(app.worker.getScan).not.toHaveBeenCalled()
  await expect(
    app.api('prepareComparisonSelection', { ...pair, targetScanId: 'a' })
  ).resolves.toMatchObject({ ok: false, error: { code: 'INCOMPATIBLE_SNAPSHOTS' } })
  await expect(
    app.api('evaluateComparisonCompatibility', { ...pair, targetScanId: 'missing' })
  ).resolves.toMatchObject({
    ok: true,
    value: { reason: { code: 'SNAPSHOT_EXPIRED', side: 'target' } }
  })
  app.db.beginScan(fixture('building').building)
  await expect(
    app.api('evaluateComparisonCompatibility', { ...pair, targetScanId: 'building' })
  ).resolves.toMatchObject({
    ok: true,
    value: { reason: { code: 'SNAPSHOT_UNAVAILABLE', side: 'target' } }
  })
  app.db.discardBuildingScan('building')
  publish(app.db, fixture('elsewhere', [], { root: '/other' }))
  await expect(
    app.api('evaluateComparisonCompatibility', { ...pair, targetScanId: 'elsewhere' })
  ).resolves.toMatchObject({ ok: true, value: { reason: { code: 'DIFFERENT_ROOTS' } } })
  expect(app.protectedIds('a', 'b', 'building', 'elsewhere')).toEqual([])
})

test.each([
  ['evaluateComparisonCompatibility', { baselineScanId: '/absolute', targetScanId: 'b' }],
  ['prepareComparisonSelection', { ...pair, targetScanId: '   ' }],
  ['prepareComparisonSelection', { ...pair, extra: true }],
  ['prepareComparisonSelection', undefined],
  ['adoptComparisonSelection', { ticket: 'not-a-ticket' }],
  ['discardPreparedComparisonSelection', { ticket: randomUUID(), extra: true }],
  ['releaseComparisonSelection', { selectionId: {} }]
] as const)('rejects invalid lifecycle input on %s before any lookup', async (method, payload) => {
  await expect(app.ipc(method, payload)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(app.worker.getScan).not.toHaveBeenCalled()
})

test('only authorizes the adopted generation and direction on all analytical channels', async () => {
  const { ticket } = await app.prepared(pair)
  await expect(
    app.api('getComparisonSummary', { selectionId: ticket, query: pair })
  ).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_UNAVAILABLE' } })
  const { selectionId } = success(await app.api('adoptComparisonSelection', { ticket }))
  await expect(app.api('adoptComparisonSelection', { ticket })).resolves.toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED' }
  })
  for (const method of [
    'getComparisonSummary',
    'listComparisonFileChanges',
    'listComparisonDirectoryChanges'
  ] as const) {
    for (const query of [replacement, reversed]) {
      await expect(app.api(method, { selectionId, query })).resolves.toMatchObject({
        ok: false,
        error: { code: 'SNAPSHOT_EXPIRED' }
      })
    }
  }
  const summary = success(await app.api('getComparisonSummary', { selectionId, query: pair }))
  const files = success(
    await app.api('listComparisonFileChanges', {
      selectionId,
      query: {
        ...pair,
        limit: 1,
        sort: 'delta-desc',
        kinds: ['modified'],
        relativeDirectory: 'sub'
      }
    })
  )
  const dirs = success(
    await app.api('listComparisonDirectoryChanges', {
      selectionId,
      query: { ...pair, includeRoot: true, limit: 2, sort: 'delta-desc' }
    })
  )
  expect(files).toMatchObject({
    pair,
    totalCount: 1,
    items: [
      {
        kind: 'modified',
        deltaBytes: 6,
        baseline: { entry: { scanId: 'a' } },
        target: { entry: { scanId: 'b' } }
      }
    ]
  })
  expect(dirs.items.find(({ relativePath }) => relativePath === '')?.subtreeFiles).toEqual(
    summary.files
  )
  const flipped = await app.adopt(reversed)
  await expect(
    app.api('getComparisonSummary', { selectionId: flipped.selectionId, query: reversed })
  ).resolves.toMatchObject({
    ok: true,
    value: { pair: reversed, files: { netKnownDeltaBytes: -6 } }
  })
})

test.each([
  ['listComparisonFileChanges', { limit: 101 }],
  ['listComparisonFileChanges', { offset: -1 }],
  ['listComparisonFileChanges', { sort: 'size' }],
  ['listComparisonFileChanges', { relativeDirectory: 'sub/../other' }],
  ['listComparisonFileChanges', { kinds: ['moved'] }],
  ['listComparisonDirectoryChanges', { kinds: 'added' }],
  ['listComparisonDirectoryChanges', { includeRoot: 1 }],
  ['listComparisonDirectoryChanges', { relativeDirectory: '/sub' }],
  ['listComparisonDirectoryChanges', { limit: 0 }],
  ['getComparisonSummary', { limit: 1 }]
] as const)('validates %s filters before dispatch', async (method, filters) => {
  const { selectionId } = await app.adopt(pair)
  await expect(
    app.ipc(method, { selectionId, query: { ...pair, ...filters } })
  ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  expect(app.worker[method]).not.toHaveBeenCalled()
})

test('rejects unauthorized frames, senders, and navigated documents and invalidates their tickets', async () => {
  const { ticket } = await app.prepared(pair)
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === IPC_CHANNELS.adoptComparisonSelection)![1]
  for (const event of [
    { ...app.event, senderFrame: { url } },
    { ...app.event, sender: {} }
  ]) {
    await expect(
      handler(event as unknown as IpcMainInvokeEvent, { ticket })
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
  }
  app.renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await expect(app.api('adoptComparisonSelection', { ticket })).resolves.toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  expect(app.protectedIds('a', 'b')).toEqual([])
  app.renderer.emit('did-finish-load')
  await expect(app.api('adoptComparisonSelection', { ticket })).resolves.toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED' }
  })
  await app.adopt(pair)
  app.renderer.emit('destroyed')
  expect(app.protectedIds('a', 'b')).toEqual([])
})

test('holds adopted, overlapping, and disjoint pairs through replacement, discard, and ticket expiry', async () => {
  const adopted = await app.adopt(pair)
  vi.useFakeTimers()
  const overlap = await app.prepared({ baselineScanId: 'b', targetScanId: 'c' })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['a', 'b', 'c'])
  const disjoint = await app.prepared(replacement)
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['a', 'b', 'c', 'd'])
  await app.api('discardPreparedComparisonSelection', { ticket: overlap.ticket })
  await expect(
    app.api('adoptComparisonSelection', { ticket: overlap.ticket })
  ).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })
  const updated = success(await app.api('adoptComparisonSelection', { ticket: disjoint.ticket }))
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['c', 'd'])
  await app.api('releaseComparisonSelection', { selectionId: adopted.selectionId })
  const expiry = await app.prepared(pair)
  await vi.advanceTimersByTimeAsync(STORAGE_REQUEST_TIMEOUT_MS)
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['c', 'd'])
  await expect(
    app.api('adoptComparisonSelection', { ticket: expiry.ticket })
  ).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })
  const discard = await app.prepared(pair)
  await app.api('discardPreparedComparisonSelection', { ticket: discard.ticket })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['c', 'd'])
  await app.api('releaseComparisonSelection', { selectionId: updated.selectionId })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual([])
})

test('keeps the adopted pair usable when replacement compatibility or tree validation fails', async () => {
  const { selectionId } = await app.adopt(pair)
  await expect(
    app.api('prepareComparisonSelection', { ...replacement, targetScanId: 'missing' })
  ).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })
  using write = new DatabaseSync(app.databasePath)
  write.exec("UPDATE entries SET aggregated_size_bytes = 999 WHERE scan_id = 'c'")
  await expect(app.api('prepareComparisonSelection', replacement)).resolves.toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_UNAVAILABLE' }
  })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['a', 'b'])
  await expect(
    app.api('getComparisonSummary', { selectionId, query: pair })
  ).resolves.toMatchObject({ ok: true })
})

test('independently protects both sources through Explorer handoff and refuses Explorer or Insights authority', async () => {
  const select = async (view: SnapshotView): Promise<SnapshotSelectionAdoption> => {
    const result = await app.ipc<PreparedSnapshotSelection>('prepareSnapshotSelection', {
      view,
      selection: { mode: 'explicit', scanId: 'a' }
    })
    expect(result).toMatchObject({ ok: true })
    return { view, ticket: success(result).ticket }
  }
  await app.ipc('adoptSnapshotSelection', await select('explorer'))
  await app.ipc('adoptSnapshotSelection', await select('insights'))
  await expect(
    app.api('getComparisonSummary', { selectionId: randomUUID(), query: pair })
  ).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_UNAVAILABLE' } })
  await app.ipc('releaseSnapshotSelection', { view: 'explorer' })
  await app.ipc('releaseSnapshotSelection', { view: 'insights' })
  const { selectionId } = await app.adopt(pair)
  const destination = await select('explorer')
  expect(app.protectedIds('a', 'b')).toEqual(['a', 'b'])
  await expect(app.ipc('adoptSnapshotSelection', destination)).resolves.toMatchObject({ ok: true })
  expect(app.protectedIds('a', 'b')).toEqual(['a', 'b'])
  await app.api('releaseComparisonSelection', { selectionId })
  expect(app.protectedIds('a', 'b')).toEqual(['a'])
  await app.ipc('releaseSnapshotSelection', { view: 'explorer' })
  expect(app.protectedIds('a', 'b')).toEqual([])
})

test('skips both pair sources during retention overflow and resumes after release', async () => {
  const { selectionId } = await app.adopt(pair)
  for (const scanId of ['a', 'b']) {
    await expect(app.ipc('deleteSnapshot', { scanId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_IN_USE' }
    })
  }
  publish(app.db, fixture('fresh'))
  await app.retention.setSettings({ maxCompletedSnapshots: 1 })
  await expect.poll(() => app.retention.status).toBe('protected')
  expect(app.db.listScanHistory({}).items.map(({ id }) => id)).toEqual(['fresh', 'b', 'a'])
  await expect(
    app.api('getComparisonSummary', { selectionId, query: pair })
  ).resolves.toMatchObject({ ok: true })
  await app.api('releaseComparisonSelection', { selectionId })
  await expect.poll(() => app.db.listScanHistory({}).items.map(({ id }) => id)).toEqual(['fresh'])
})

test('rolls back the first reservation if the second source is already admitted for deletion', async () => {
  const gate = Promise.withResolvers<void>()
  const blocker = app.storage.read(new AbortController().signal, () => gate.promise)
  const deleting = app.storage.deleteSnapshot({ scanId: 'b' })
  await expect(app.api('prepareComparisonSelection', pair)).resolves.toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_IN_USE' }
  })
  await expect(app.api('evaluateComparisonCompatibility', pair)).resolves.toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_IN_USE' }
  })
  expect(app.protectedIds('a', 'b')).toEqual([])
  expect(app.worker.getScan).not.toHaveBeenCalled()
  gate.resolve()
  await blocker
  await deleting
})

test('holds both sources for a queued compatibility request and drops it on document replacement', async () => {
  const gate = Promise.withResolvers<void>()
  const blocker = app.storage.read(new AbortController().signal, () => gate.promise)
  const reading = app.api('evaluateComparisonCompatibility', pair)
  expect(app.protectedIds('a', 'b')).toEqual(['a', 'b'])
  for (const scanId of ['a', 'b']) {
    await expect(app.storage.deleteSnapshot({ scanId })).rejects.toMatchObject({
      code: 'SNAPSHOT_IN_USE'
    })
  }
  app.renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await expect(reading).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(app.protectedIds('a', 'b')).toEqual([])
  gate.resolve()
  await blocker
  expect(app.worker.getScan).not.toHaveBeenCalled()
})

test('shares the registry across all three views at their maximum concurrent ownership', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  for (const id of ids.slice(4)) publish(app.db, fixture(id))
  for (const [view, current, next] of [
    ['explorer', 'e', 'f'],
    ['insights', 'g', 'h']
  ]) {
    const prepare = (scanId: string): Promise<FixtureResult<PreparedSnapshotSelection>> =>
      app.ipc('prepareSnapshotSelection', {
        view,
        selection: { mode: 'explicit', scanId }
      })
    const prepared = await prepare(current)
    expect(prepared).toMatchObject({ ok: true })
    await expect(
      app.ipc('adoptSnapshotSelection', { view, ticket: success(prepared).ticket })
    ).resolves.toMatchObject({ ok: true })
    await expect(prepare(next)).resolves.toMatchObject({ ok: true })
  }
  await app.adopt(pair)
  await app.prepared(replacement)
  expect(app.protectedIds(...ids)).toEqual(ids)
  app.renderer.emit('destroyed')
  expect(app.protectedIds(...ids)).toEqual([])
})

test('supersedes in-flight preparation and abandons the initial visit before dispatch', async () => {
  const gate = Promise.withResolvers<void>()
  const blocker = app.storage.read(new AbortController().signal, () => gate.promise)
  const old = app.api('prepareComparisonSelection', pair)
  const next = app.api('prepareComparisonSelection', replacement)
  await expect(old).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['c', 'd'])
  await app.api('releaseComparisonSelection', { selectionId: null })
  await expect(next).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual([])
  gate.resolve()
  await blocker
  expect(app.worker.getScan).not.toHaveBeenCalled()
})

test('bounds queued comparison admissions and drops an obsolete generation before dispatch', async () => {
  const { selectionId } = await app.adopt(pair)
  const gate = Promise.withResolvers<void>()
  const blocker = app.storage.read(new AbortController().signal, () => gate.promise)
  const request = { selectionId, query: pair }
  const pending = Array.from({ length: MAX_QUEUED_EXPLORER_READS }, () =>
    app.api('getComparisonSummary', request)
  )
  await expect(app.api('getComparisonSummary', request)).resolves.toMatchObject({
    ok: false,
    error: { code: 'UNAVAILABLE' }
  })
  await app.api('releaseComparisonSelection', { selectionId })
  expect(app.protectedIds('a', 'b')).toEqual([])
  for (const result of await Promise.all(pending))
    expect(result).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })
  gate.resolve()
  await blocker
  expect(app.worker.getComparisonSummary).not.toHaveBeenCalled()
})

test('keeps both reservations for a dispatched obsolete reply until Worker settlement', async () => {
  const old = await app.adopt(pair)
  const next = await app.prepared(replacement)
  const result = app.db.getComparisonSummary(pair)
  const gate = Promise.withResolvers<typeof result>()
  app.worker.getComparisonSummary.mockReturnValueOnce(gate.promise)
  await yieldToStorage()
  const inFlight = app.api('getComparisonSummary', { selectionId: old.selectionId, query: pair })
  expect(app.worker.getComparisonSummary).toHaveBeenCalledOnce()
  success(await app.api('adoptComparisonSelection', { ticket: next.ticket }))
  await expect(inFlight).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['a', 'b', 'c', 'd'])
  for (const scanId of ['a', 'b']) {
    await expect(app.storage.deleteSnapshot({ scanId })).rejects.toMatchObject({
      code: 'SNAPSHOT_IN_USE'
    })
  }
  gate.resolve(result)
  const latest = await app.adopt(pair)
  expect(latest.selectionId).not.toBe(old.selectionId)
  await expect(
    app.api('getComparisonSummary', { selectionId: old.selectionId, query: pair })
  ).resolves.toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })
  expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual(['a', 'b'])
})

test('releases queued timeout holds immediately and retains dispatched timeout holds until confirmed exit', async () => {
  const { selectionId } = await app.adopt(pair)
  vi.useFakeTimers()
  const blocker = Promise.withResolvers<void>()
  const occupied = app.storage.read(new AbortController().signal, () => blocker.promise)
  const request = { selectionId, query: pair }
  const queued = app.api('getComparisonSummary', request)
  await vi.advanceTimersByTimeAsync(STORAGE_REQUEST_TIMEOUT_MS)
  await expect(queued).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  blocker.resolve()
  await occupied
  await Promise.resolve()
  const failed = Promise.withResolvers<ReturnType<ScanDatabase['getComparisonSummary']>>()
  app.worker.getComparisonSummary.mockReturnValueOnce(failed.promise)
  const dispatched = app.api('getComparisonSummary', request)
  expect(app.worker.getComparisonSummary).toHaveBeenCalledOnce()
  app.worker.isReady = false
  failed.reject(new Error('Worker deadline'))
  await expect(dispatched).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  await app.api('releaseComparisonSelection', { selectionId })
  expect(app.protectedIds('a', 'b')).toEqual(['a', 'b'])
  app.exit.resolve()
  await Promise.resolve()
  expect(app.protectedIds('a', 'b')).toEqual([])
})

test('prioritizes scanner writes between tree validation and later preparation reads', async () => {
  const order: string[] = []
  const gate = Promise.withResolvers<void>()
  const building = fixture('ingesting')
  await app.storage.beginScan(building.building)
  app.worker.requireValidatedScan.mockImplementation(async (id) => {
    order.push(id)
    if (id === 'a') await gate.promise
    return app.db.requireValidatedScan(id)
  })
  app.worker.applyBatch.mockImplementation(async (scanId, entries) => {
    order.push('scanner')
    app.db.applyBatch(scanId, entries)
  })
  const preparing = app.prepared(pair)
  await yieldToStorage()
  expect(order).toEqual(['a'])
  const ack = app.storage
    .applyBatch('ingesting', [
      { type: 'entry', entry: { ...building.entries[0], aggregatedSizeBytes: null } }
    ])
    .then(() => order.push('ack'))
  gate.resolve()
  await ack
  await preparing
  expect(order).toEqual(['a', 'scanner', 'ack', 'b'])
})

test('sanitizes both typed and unexpected errors and keeps the healthy selection available', async () => {
  const { selectionId } = await app.adopt(pair)
  const request = { selectionId, query: pair }
  const secret = 'SELECT * FROM C:\\private\\saved.sqlite'
  for (const [error, code] of [
    [new Error(secret), 'INTERNAL_ERROR'],
    [
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        code: 'SIZE_OVERFLOW',
        message: secret,
        sqliteCode: null
      }),
      'SIZE_OVERFLOW'
    ],
    [
      new StorageWorkerError({
        name: 'ComparisonStorageError',
        code: 'AMBIGUOUS_COMPARISON_PATH',
        message: secret,
        sqliteCode: null
      }),
      'AMBIGUOUS_COMPARISON_PATH'
    ]
  ] as const) {
    app.worker.getComparisonSummary.mockRejectedValueOnce(error)
    const result = await app.api('getComparisonSummary', request)
    expect(result).toMatchObject({ ok: false, error: { code } })
    expect(JSON.stringify(result)).not.toContain('private')
  }
  await expect(app.api('getComparisonSummary', request)).resolves.toMatchObject({ ok: true })
})

test.each(['shutdown', 'worker exit'] as const)(
  'releases view and pending owners on %s',
  async (end) => {
    await app.adopt(pair)
    const { ticket } = await app.prepared(replacement)
    if (end === 'shutdown') {
      app.storage.stopReads()
    } else {
      app.worker.isReady = false
      app.exit.resolve()
      await Promise.resolve()
    }
    expect(app.protectedIds('a', 'b', 'c', 'd')).toEqual([])
    await expect(app.api('adoptComparisonSelection', { ticket })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' }
    })
    await app.boundary.dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getComparisonSummary)
  }
)

test('discards an acknowledgement when shutdown invalidates adoption before the IPC reply', async () => {
  const { ticket } = await app.prepared(pair)
  const adopting = app.api('adoptComparisonSelection', { ticket })
  app.storage.stopReads()
  await expect(adopting).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(app.protectedIds('a', 'b')).toEqual([])
})
