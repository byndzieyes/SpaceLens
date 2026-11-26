// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { app, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC_CHANNELS, type ScannerIpcResult, type ScanStateSnapshot } from '../src/shared/ipc'
import { INSIGHTS_SIZE_BUCKETS } from '../src/shared/insights'
import type { CompletedScan } from '../src/main/storage/payloads'
import type { FileEntry, ScanSessionState } from '../src/shared/scan'
import type { ScanSessionManager, ScanSessionSubscriber } from '../src/main/scanner/sessionManager'
import { registerScannerIpc, registerScannerShutdown } from '../src/main/scannerIpc'
import { registerAppInfoHandler } from '../src/main/ipc'
import { verifyScanDirectory } from '../src/main/scanner/directoryApproval'
import { ScanStorageError } from '../src/main/scanner/persistence'
import { ScanDatabase } from '../src/main/storage/database'
import {
  StorageUnavailableError,
  type ScanStorageCoordinator
} from '../src/main/storage/coordinator'
import { StorageWorkerError, type StorageWorkerClient } from '../src/main/storage/workerClient'
import { SnapshotProtection } from '../src/main/storage/snapshotProtection'
import type {
  PreparedSnapshotSelection,
  SnapshotSelectionRequest
} from '../src/shared/snapshotSelection'
import type { ScanSnapshot } from '../src/shared/snapshot'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
    app: Object.assign(new EventEmitter(), {
      quit: vi.fn(),
      getName: () => 'SpaceLens',
      getVersion: () => '0.1.0'
    }),
    BrowserWindow: { fromWebContents: vi.fn(() => ({ isDestroyed: () => false })) },
    dialog: { showOpenDialog: vi.fn() }
  }
})

vi.mock('../src/main/scanner/directoryApproval', () => ({
  inspectScanDirectory: vi.fn(async (path: string) => ({ path, dev: 1n, ino: 1n })),
  verifyScanDirectory: vi.fn(async () => true)
}))

const url = 'file:///app/index.html'
const rootPath = resolve('approved-fixture')
const id = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
let state: ScanSessionState | null
let subscriber: ScanSessionSubscriber
let settle: (value: ScanSessionState) => void
let reject: (error: unknown) => void
let renderer: ReturnType<typeof makeRenderer>
let boundary: ReturnType<typeof registerScannerIpc>
let protection: SnapshotProtection
let manager: ScanSessionManager
let start: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
let dispose: ReturnType<typeof vi.fn>
let unsubscribe: ReturnType<typeof vi.fn>
const queries = {
  requireValidatedScan: vi.fn<StorageWorkerClient['requireValidatedScan']>(),
  getInsightsCategories: vi.fn<StorageWorkerClient['getInsightsCategories']>(),
  getInsightsSizeDistribution: vi.fn<StorageWorkerClient['getInsightsSizeDistribution']>(),
  getInsightsObservations: vi.fn<StorageWorkerClient['getInsightsObservations']>(),
  listInsightsExtensions: vi.fn<StorageWorkerClient['listInsightsExtensions']>(),
  listInsightsLargestFiles: vi.fn<StorageWorkerClient['listInsightsLargestFiles']>(),
  listInsightsLargestDirectories: vi.fn<StorageWorkerClient['listInsightsLargestDirectories']>(),
  getScanSnapshot: vi.fn<StorageWorkerClient['getScanSnapshot']>(),
  openSavedSnapshot: vi.fn<StorageWorkerClient['openSavedSnapshot']>(),
  listScanHistory: vi.fn<StorageWorkerClient['listScanHistory']>(),
  getScanHistoryMetadata: vi.fn<StorageWorkerClient['getScanHistoryMetadata']>(),
  listComparisonMatches: vi.fn<StorageWorkerClient['listComparisonMatches']>(),
  listComparisonFileChanges: vi.fn<StorageWorkerClient['listComparisonFileChanges']>(),
  getComparisonSummary: vi.fn<StorageWorkerClient['getComparisonSummary']>(),
  listComparisonDirectoryChanges: vi.fn<StorageWorkerClient['listComparisonDirectoryChanges']>(),
  getScanEntry: vi.fn<StorageWorkerClient['getScanEntry']>(),
  listScanDirectory: vi.fn<StorageWorkerClient['listScanDirectory']>(),
  getScanDirectoryTreemap: vi.fn<StorageWorkerClient['getScanDirectoryTreemap']>()
}
const storage = {
  read: (async (_signal, query) => query(queries)) as ScanStorageCoordinator['read'],
  deleteSnapshot: vi.fn<ScanStorageCoordinator['deleteSnapshot']>(),
  createSnapshotOwner: vi.fn<ScanStorageCoordinator['createSnapshotOwner']>()
}

function makeRenderer(): EventEmitter & {
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  mainFrame: { url: string }
  send: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
} {
  return Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    mainFrame: { url },
    send: vi.fn()
  })
}

function running(): ScanSessionState {
  return {
    session: {
      id,
      rootPath,
      status: 'running',
      startedAt: '2026-11-09T00:00:00.000Z',
      finishedAt: null,
      summary: { fileCount: 0, directoryCount: 1, totalBytes: 0, errorCount: 0 }
    },
    progress: {
      scanId: id,
      processedFileCount: 0,
      processedDirectoryCount: 1,
      processedBytes: 0,
      currentPath: rootPath
    },
    failure: null
  }
}

function event(target = renderer): IpcMainInvokeEvent {
  return { sender: target, senderFrame: target.mainFrame } as unknown as IpcMainInvokeEvent
}

function invoke(
  channel: string,
  args: unknown[] = [],
  sender = event()
): ScannerIpcResult<unknown> {
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1]
  return handler(sender, ...args) as ScannerIpcResult<unknown>
}

function ack(revision: number, sender = event()): void {
  ipcMain.emit(IPC_CHANNELS.acknowledgeScanState, sender, revision)
}

async function prepareExplicit(
  scanId: string,
  view: SnapshotSelectionRequest['view'] = 'explorer'
): Promise<PreparedSnapshotSelection> {
  queries.getScanHistoryMetadata.mockResolvedValueOnce({
    ...completed(),
    id: scanId,
    durationMs: 1000,
    isLatest: false,
    incomplete: false
  })
  const result = (await invoke(IPC_CHANNELS.prepareSnapshotSelection, [
    { view, selection: { mode: 'explicit', scanId } }
  ])) as ScannerIpcResult<PreparedSnapshotSelection>
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function adoptExplorer(scanId: string): Promise<void> {
  const { ticket } = await prepareExplicit(scanId)
  expect(
    await invoke(IPC_CHANNELS.adoptSnapshotSelection, [{ view: 'explorer', ticket }])
  ).toMatchObject({
    ok: true,
    value: { entries: { scanId } }
  })
}

async function adoptInsights(scanId: string, keepCurrent = false): Promise<void> {
  const { ticket } = await prepareExplicit(scanId, 'insights')
  expect(
    await invoke(IPC_CHANNELS.adoptSnapshotSelection, [
      { view: 'insights', ticket, ...(keepCurrent ? { keepCurrent: true } : {}) }
    ])
  ).toEqual({ ok: true, value: null })
}

beforeEach(async () => {
  vi.clearAllMocks()
  for (const query of Object.values(queries)) query.mockReset()
  storage.deleteSnapshot.mockReset()
  protection = new SnapshotProtection()
  storage.createSnapshotOwner.mockImplementation((signal) =>
    protection.createOwner(signal, (scanId) => queries.getScanHistoryMetadata({ scanId }))
  )
  queries.getScanSnapshot.mockResolvedValue({ snapshot: null, unavailable: null })
  queries.openSavedSnapshot.mockImplementation(async (scanId): Promise<ScanSnapshot> => {
    const scan = completed()
    return {
      entries: { scanId, rootEntryId: 'root' },
      root: {
        scanId,
        id: 'root',
        parentId: null,
        name: 'root',
        path: rootPath,
        type: 'directory',
        aggregatedSizeBytes: 0,
        sizeBytes: null,
        createdAt: null,
        modifiedAt: null
      },
      completedAt: scan.finishedAt,
      summary: scan.summary,
      incomplete: false,
      entryCount: 1
    }
  })
  state = null
  renderer = makeRenderer()
  unsubscribe = vi.fn()
  cancel = vi.fn(() => true)
  dispose = vi.fn(async () => {})
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [rootPath] })
  start = vi.fn(async () => {
    state = running()
    subscriber(state)
    return {
      scanId: id,
      done: new Promise<ScanSessionState>((done, fail) => {
        settle = done
        reject = fail
      })
    }
  })
  manager = {
    getState: () => state,
    launch: start,
    cancel,
    dispose,
    subscribe: (callback: ScanSessionSubscriber) => {
      subscriber = callback
      return unsubscribe
    }
  } as unknown as ScanSessionManager
  boundary = registerScannerIpc(manager, url, storage, Promise.resolve(null))
  await Promise.resolve()
  boundary.attachRenderer(renderer as unknown as WebContents)
  ack((renderer.send.mock.calls.at(-1)![1] as ScanStateSnapshot).revision)
  renderer.send.mockClear()
})

afterEach(async () => {
  await boundary.dispose()
  ipcMain.removeAllListeners()
  app.removeAllListeners()
  vi.restoreAllMocks()
})

test('retrieval uses fixed, authorized channels and forwards bounded ID-only queries to storage', async () => {
  expect(await invoke(IPC_CHANNELS.getScanSnapshot)).toEqual({
    ok: true,
    value: { snapshot: null, unavailable: null }
  })
  await adoptExplorer(id)
  const request = { scanId: id, entryId: otherId }
  const value = { id: otherId, scanId: id, type: 'directory' }
  queries.getScanEntry.mockResolvedValue(
    value as Awaited<ReturnType<StorageWorkerClient['getScanEntry']>>
  )
  expect(await invoke(IPC_CHANNELS.getScanEntry, [request])).toEqual({ ok: true, value })
  expect(queries.getScanEntry).toHaveBeenCalledExactlyOnceWith(request)
  const page = { ...request, offset: 100, limit: 100 }
  await invoke(IPC_CHANNELS.listScanDirectory, [page])
  expect(queries.listScanDirectory).toHaveBeenCalledExactlyOnceWith(page)
  const treemap = { ...request, limit: 100 }
  const aggregated = {
    scanId: id,
    directoryId: otherId,
    totalCount: 0,
    individualCount: 0,
    unknownCount: 0,
    entries: [],
    other: null
  }
  queries.getScanDirectoryTreemap.mockResolvedValue(aggregated)
  expect(await invoke(IPC_CHANNELS.getScanDirectoryTreemap, [treemap])).toEqual({
    ok: true,
    value: aggregated
  })
  expect(queries.getScanDirectoryTreemap).toHaveBeenCalledExactlyOnceWith(treemap)
  expect(queries.getScanEntry).toHaveBeenCalledTimes(1)
})

test('authorizes selection calls and rejects malformed, unrecognized and cross-view requests', async () => {
  const {
    prepareSnapshotSelection: prepare,
    adoptSnapshotSelection: adopt,
    releaseSnapshotSelection: release
  } = IPC_CHANNELS
  const request = { view: 'explorer', selection: { mode: 'explicit', scanId: id } }
  for (const channel of [prepare, adopt, release]) {
    for (const sender of [event(makeRenderer()), { ...event(), senderFrame: null }]) {
      expect(await invoke(channel, [], sender)).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' }
      })
    }
  }
  for (const malformed of [
    [],
    [request, request],
    [{ ...request, view: 'comparison' }],
    [{ ...request, owner: 'custom' }],
    [{ ...request, selection: { mode: 'explicit', scanId: '../scan' } }],
    [{ ...request, selection: { mode: 'follow-latest', scanId: id } }]
  ]) {
    expect(await invoke(prepare, malformed)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(await invoke(adopt, [{ view: 'explorer', ticket: 'unvalidated' }])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(await invoke(release, [{ view: 'comparison' }])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(storage.createSnapshotOwner).not.toHaveBeenCalled()

  queries.getScanHistoryMetadata.mockResolvedValue({
    ...running().session,
    status: 'completed',
    finishedAt: '2026-11-09T00:00:01.000Z',
    durationMs: 1000,
    isLatest: true,
    incomplete: false
  })
  const selection = (await invoke(prepare, [
    request
  ])) as ScannerIpcResult<PreparedSnapshotSelection>
  expect(selection).toMatchObject({
    ok: true,
    value: { resolution: { mode: 'explicit', metadata: { id } } }
  })
  if (!selection.ok) throw new Error('Snapshot selection failed.')
  const adoption = { view: 'explorer', ticket: selection.value.ticket }
  expect(protection.isProtected(id)).toBe(true)
  expect(await invoke(adopt, [{ ...adoption, view: 'insights' }])).toMatchObject({
    ok: false,
    error: { code: 'UNAVAILABLE' }
  })
  expect(await invoke(adopt, [adoption])).toMatchObject({
    ok: true,
    value: { entries: { scanId: id } }
  })
  expect(await invoke(release, [{ view: 'insights' }])).toEqual({ ok: true, value: null })
  expect(protection.isProtected(id)).toBe(true)
  for (let call = 0; call < 2; call++) {
    expect(await invoke(release, [{ view: 'explorer' }])).toEqual({ ok: true, value: null })
  }
  expect(protection.isProtected(id)).toBe(false)
})

test('an unrelated lease and a prepared Explorer selection grant no entry access', async () => {
  const { ticket: insights } = await prepareExplicit(id, 'insights')
  await invoke(IPC_CHANNELS.adoptSnapshotSelection, [{ view: 'insights', ticket: insights }])
  const read = { scanId: id, entryId: 'root' }
  const { ticket } = await prepareExplicit(id)
  expect(await invoke(IPC_CHANNELS.getScanEntry, [read])).toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_UNAVAILABLE' }
  })
  expect(queries.getScanEntry).not.toHaveBeenCalled()
  expect(protection.isProtected(id)).toBe(true)
  await invoke(IPC_CHANNELS.adoptSnapshotSelection, [{ view: 'explorer', ticket }])
  const first = Promise.withResolvers<FileEntry>()
  queries.getScanEntry.mockReturnValueOnce(first.promise)
  const stale = invoke(IPC_CHANNELS.getScanEntry, [read])
  await adoptExplorer(otherId)
  await adoptExplorer(id)
  first.resolve((await queries.openSavedSnapshot(id)).root)
  expect(await stale).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })
  const oldDocument = event()
  renderer.emit('did-start-navigation', { isMainFrame: true })
  expect(await invoke(IPC_CHANNELS.getScanEntry, [read], oldDocument)).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  renderer.mainFrame = { url }
  renderer.emit('did-finish-load')
  expect(await invoke(IPC_CHANNELS.getScanEntry, [read], oldDocument)).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  expect(await invoke(IPC_CHANNELS.getScanEntry, [read])).toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_UNAVAILABLE' }
  })
})

test('invalidates active and pending view ownership on document replacement, process loss and shutdown', async () => {
  const {
    prepareSnapshotSelection: prepare,
    adoptSnapshotSelection: adopt,
    releaseSnapshotSelection: release
  } = IPC_CHANNELS
  const request = (scanId: string): SnapshotSelectionRequest => ({
    view: 'explorer',
    selection: { mode: 'explicit', scanId }
  })
  const metadata = {
    ...running().session,
    status: 'completed',
    finishedAt: '2026-11-09T00:00:01.000Z',
    durationMs: 1000,
    isLatest: true,
    incomplete: false
  } as const
  queries.getScanHistoryMetadata.mockResolvedValue(metadata)
  const value = (await invoke(prepare, [
    request(id)
  ])) as ScannerIpcResult<PreparedSnapshotSelection>
  if (!value.ok) throw new Error('Snapshot selection failed.')
  const adoption = { view: 'explorer', ticket: value.value.ticket }
  expect(await invoke(adopt, [adoption])).toMatchObject({
    ok: true,
    value: { entries: { scanId: id } }
  })
  const pending = Promise.withResolvers<typeof metadata>()
  queries.getScanHistoryMetadata.mockReturnValueOnce(pending.promise)
  const inFlight = invoke(prepare, [request(otherId)])
  await vi.waitFor(() => expect(queries.getScanHistoryMetadata).toHaveBeenCalledTimes(2))
  expect(protection.isProtected(id)).toBe(true)
  expect(protection.isProtected(otherId)).toBe(true)
  const oldDocument = event()
  renderer.emit('did-start-navigation', { isMainFrame: true })
  expect(protection.isProtected(id)).toBe(false)
  expect(protection.isProtected(otherId)).toBe(false)
  expect(await invoke(prepare, [request(id)], oldDocument)).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  renderer.mainFrame = { url }
  renderer.emit('did-finish-load')
  expect(await invoke(release, [{ view: 'explorer' }], oldDocument)).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  expect(await invoke(adopt, [adoption])).toMatchObject({
    ok: false,
    error: { code: 'UNAVAILABLE' }
  })
  pending.resolve({ ...metadata, id: otherId })
  expect(await inFlight).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(protection.isProtected(otherId)).toBe(false)

  expect(await invoke(prepare, [request(id)])).toMatchObject({ ok: true })
  renderer.emit('render-process-gone')
  expect(protection.isProtected(id)).toBe(false)
  renderer.emit('did-finish-load')
  expect(await invoke(prepare, [request(id)])).toMatchObject({ ok: true })
  renderer.emit('destroyed')
  expect(protection.isProtected(id)).toBe(false)
  const replacement = makeRenderer()
  boundary.attachRenderer(replacement as unknown as WebContents)
  expect(await invoke(prepare, [request(id)], event(replacement))).toMatchObject({ ok: true })
  expect(protection.isProtected(id)).toBe(true)
  await boundary.dispose()
  expect(protection.protectedScanIds()).toEqual([])
})

test('selection errors preserve typed failures and sanitize invalid stored metadata', async () => {
  const request = { view: 'insights', selection: { mode: 'explicit', scanId: id } }
  const prepare = IPC_CHANNELS.prepareSnapshotSelection
  for (const code of ['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE'] as const) {
    queries.getScanHistoryMetadata.mockRejectedValueOnce(
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        message: 'Saved scan unavailable.',
        code,
        sqliteCode: null
      })
    )
    expect(await invoke(prepare, [request])).toMatchObject({ ok: false, error: { code } })
  }
  queries.getScanHistoryMetadata.mockRejectedValueOnce(new Error('private database path'))
  expect(await invoke(prepare, [request])).toEqual({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'The snapshot request could not be processed.' }
  })
  expect(protection.protectedScanIds()).toEqual([])
})

const completed = (): CompletedScan => ({
  ...running().session,
  status: 'completed',
  finishedAt: '2026-11-12T12:00:00Z'
})

test('validates, authorizes, and forwards history reads on the existing renderer boundary', async () => {
  const item = { ...completed(), durationMs: 302400000, isLatest: true, incomplete: false }
  const page = {
    items: [item],
    offset: 0,
    limit: 20,
    totalCount: 1,
    nextOffset: null,
    latestCompletedScanId: item.id
  }
  queries.listScanHistory.mockResolvedValue(page)
  queries.getScanHistoryMetadata.mockResolvedValue(item)
  const { listScanHistory, getScanHistoryMetadata } = IPC_CHANNELS
  for (const [channel, args] of [
    [listScanHistory, [{}]],
    [getScanHistoryMetadata, [{ scanId: id }]]
  ] as const) {
    expect(await invoke(channel, [...args], event(makeRenderer()))).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
  }
  for (const args of [[], [{ limit: 101 }], [{ sort: 'total_bytes' }], [{}, {}]]) {
    expect(await invoke(listScanHistory, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(await invoke(getScanHistoryMetadata, [{ scanId: 'bad/path' }])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(queries.listScanHistory).not.toHaveBeenCalled()
  expect(queries.getScanHistoryMetadata).not.toHaveBeenCalled()
  expect(await invoke(listScanHistory, [{ rootPathContains: '%_' }])).toEqual({
    ok: true,
    value: page
  })
  expect(queries.listScanHistory).toHaveBeenCalledExactlyOnceWith({
    offset: 0,
    limit: 20,
    sort: 'newest',
    rootPathContains: '%_'
  })
  expect(await invoke(getScanHistoryMetadata, [{ scanId: id }])).toEqual({ ok: true, value: item })
  expect(queries.getScanHistoryMetadata).toHaveBeenCalledExactlyOnceWith({ scanId: id })
})

test.each(['navigation', 'destroyed'])(
  'invalidates history replies after renderer %s',
  async (eventName) => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<StorageWorkerClient['listScanHistory']>>>()
    queries.listScanHistory.mockReturnValueOnce(pending.promise)
    const reply = invoke(IPC_CHANNELS.listScanHistory, [{}])
    if (eventName === 'navigation') renderer.emit('did-start-navigation', { isMainFrame: true })
    else renderer.emit('destroyed')
    pending.resolve({
      items: [],
      totalCount: 0,
      latestCompletedScanId: null,
      offset: 0,
      limit: 20,
      nextOffset: null
    })
    expect(await reply).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  }
)

test('returns typed history errors and sanitizes backend diagnostics', async () => {
  const request = { scanId: id }
  queries.getScanHistoryMetadata.mockRejectedValueOnce(
    new StorageWorkerError({
      code: 'SNAPSHOT_EXPIRED',
      name: 'SnapshotAccessError',
      message: 'Saved scan missing.',
      sqliteCode: null
    })
  )
  expect(await invoke(IPC_CHANNELS.getScanHistoryMetadata, [request])).toEqual({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED', message: 'Saved scan missing.' }
  })
  queries.getScanHistoryMetadata.mockRejectedValueOnce(new Error('private SQLite metadata'))
  expect(await invoke(IPC_CHANNELS.getScanHistoryMetadata, [request])).toEqual({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'The scan history request could not be processed.' }
  })
})

async function attachWithRecovery(
  publication: Promise<CompletedScan | null>,
  retention?: Parameters<typeof registerScannerIpc>[4]
): Promise<void> {
  await boundary.dispose()
  vi.mocked(ipcMain.handle).mockClear()
  boundary = registerScannerIpc(manager, url, storage, publication, retention)
  boundary.attachRenderer(renderer as unknown as WebContents)
  ack((renderer.send.mock.calls.at(-1)![1] as ScanStateSnapshot).revision)
  renderer.send.mockClear()
}

test('restores a published summary over the existing channel while the scanner stays idle', async () => {
  const recovery = Promise.withResolvers<CompletedScan | null>()
  await attachWithRecovery(recovery.promise)
  expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
    ok: true,
    value: { state: null, latestCompleted: null, publicationStatus: 'loading' }
  })
  const scan = {
    ...completed(),
    summary: { fileCount: 8, directoryCount: 3, totalBytes: 1024, errorCount: 2 }
  }
  const restored = {
    id: scan.id,
    path: scan.rootPath,
    completedAt: scan.finishedAt,
    ...scan.summary
  }
  recovery.resolve(scan)
  await Promise.resolve()
  expect(renderer.send).toHaveBeenLastCalledWith(
    IPC_CHANNELS.scanStateChanged,
    expect.objectContaining({
      state: null,
      latestCompleted: restored,
      publicationStatus: 'ready',
      snapshotUnavailable: null
    })
  )
  expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
    ok: true,
    value: { state: null, latestCompleted: restored }
  })
})

test('keeps the acknowledged publication when recovery or later unsuccessful sessions deliver updates', async () => {
  const recovery = Promise.withResolvers<CompletedScan | null>()
  await attachWithRecovery(recovery.promise)
  const scan = completed()
  state = { ...running(), session: scan }
  subscriber(state)
  recovery.resolve({ ...scan, id: otherId })
  await Promise.resolve()
  for (const status of ['running', 'cancelled', 'failed'] as const) {
    state = {
      ...running(),
      session: status === 'running' ? running().session : { ...scan, status }
    }
    subscriber(state)
    expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
      ok: true,
      value: {
        publicationStatus: 'ready',
        latestCompleted: { id: scan.id, completedAt: scan.finishedAt }
      }
    })
  }
})

test('restores Latest to Overview and uses independently adopted historical Explorer and Insights selections', async () => {
  const db = new ScanDatabase(':memory:')
  try {
    const previous = completed()
    const latest = { ...previous, id: otherId, finishedAt: '2026-11-10T12:00:00Z' }
    const root: FileEntry = {
      id: 'root',
      scanId: latest.id,
      parentId: null,
      name: 'approved-fixture',
      path: rootPath,
      type: 'directory',
      sizeBytes: null,
      aggregatedSizeBytes: null,
      createdAt: null,
      modifiedAt: null
    }
    for (const scan of [previous, latest]) {
      db.beginScan({
        ...scan,
        status: 'running',
        finishedAt: null,
        summary: { ...scan.summary, directoryCount: 0 }
      })
      const directory = { ...root, scanId: scan.id }
      db.applyBatch(scan.id, [
        { type: 'entry', entry: directory },
        {
          type: 'directory-finalized',
          entry: { ...directory, type: 'directory', aggregatedSizeBytes: 0 }
        }
      ])
      db.publishScan(scan, root.id)
    }
    db.recoverStorage()
    await attachWithRecovery(Promise.resolve(db.getPublishedScan()))
    expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
      ok: true,
      value: { state: null, latestCompleted: { id: latest.id, completedAt: latest.finishedAt } }
    })

    queries.getScanEntry.mockImplementation(async (request) => db.getScanEntry(request))
    queries.openSavedSnapshot.mockImplementation(async (scanId) => db.openSavedSnapshot({ scanId }))
    queries.requireValidatedScan.mockImplementation(async (scanId) =>
      db.requireValidatedScan(scanId)
    )
    const entry = { scanId: previous.id, entryId: root.id }
    expect(db.getEntry(previous.id, root.id)).toEqual({
      ...root,
      scanId: previous.id,
      aggregatedSizeBytes: 0
    })
    expect(await invoke(IPC_CHANNELS.getScanEntry, [entry], event(makeRenderer()))).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    expect(await invoke(IPC_CHANNELS.getScanEntry, [entry])).toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_UNAVAILABLE' }
    })
    await adoptExplorer(previous.id)
    expect(await invoke(IPC_CHANNELS.getScanEntry, [entry])).toMatchObject({
      ok: true,
      value: { scanId: previous.id, id: root.id }
    })
    expect(
      await invoke(IPC_CHANNELS.getScanEntry, [{ ...entry, scanId: latest.id }])
    ).toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_EXPIRED' }
    })
    expect(await invoke(IPC_CHANNELS.getInsightsSummary, [{ scanId: previous.id }])).toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_UNAVAILABLE' }
    })
    await adoptInsights(previous.id)
    expect(await invoke(IPC_CHANNELS.getInsightsSummary, [{ scanId: previous.id }])).toMatchObject({
      ok: true,
      value: { scanId: previous.id, completedAt: previous.finishedAt }
    })
    expect(await invoke(IPC_CHANNELS.getInsightsSummary, [{ scanId: latest.id }])).toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_EXPIRED' }
    })
    await adoptInsights(latest.id)
    expect(await invoke(IPC_CHANNELS.getInsightsSummary, [{ scanId: latest.id }])).toMatchObject({
      ok: true,
      value: { scanId: latest.id, completedAt: latest.finishedAt }
    })
  } finally {
    db.close()
  }
})

test('reports startup recovery failure without inventing a publication', async () => {
  const recovery = Promise.withResolvers<CompletedScan | null>()
  await attachWithRecovery(recovery.promise)
  recovery.reject(new Error('Recovery failed'))
  await vi.waitFor(() =>
    expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
      ok: true,
      value: { state: null, latestCompleted: null, publicationStatus: 'unavailable' }
    })
  )
})

test('authorizes explicit deletion and publishes a new history revision for each confirmed deletion', async () => {
  const latest = completed()
  const previous = { ...latest, id: otherId }
  await attachWithRecovery(Promise.resolve(latest))
  ack((renderer.send.mock.calls.at(-1)![1] as ScanStateSnapshot).revision)
  renderer.send.mockClear()
  const channel = IPC_CHANNELS.deleteSnapshot
  expect(await invoke(channel, [{ scanId: id }], event(makeRenderer()))).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  expect(await invoke(channel, [{ scanId: id, path: rootPath }])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(storage.deleteSnapshot).not.toHaveBeenCalled()
  for (const code of ['SNAPSHOT_IN_USE', 'SNAPSHOT_DELETE_UNCERTAIN']) {
    storage.deleteSnapshot.mockRejectedValueOnce(
      new StorageWorkerError({
        code,
        name: 'SnapshotAccessError',
        message: 'Deletion was not confirmed.',
        sqliteCode: null
      })
    )
    expect(await invoke(channel, [{ scanId: id }])).toMatchObject({ ok: false, error: { code } })
  }
  storage.deleteSnapshot.mockRejectedValueOnce(new Error('SQLite commit failed with private path'))
  expect(await invoke(channel, [{ scanId: id }])).toMatchObject({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'The scan history request could not be processed.' }
  })
  expect(renderer.send).not.toHaveBeenCalled()

  storage.deleteSnapshot.mockResolvedValueOnce({
    scanId: 'historical',
    latestCompletedScanId: id,
    latestCompleted: latest
  })
  expect(await invoke(channel, [{ scanId: 'historical' }])).toEqual({
    ok: true,
    value: { scanId: 'historical', latestCompletedScanId: id }
  })
  expect(renderer.send).toHaveBeenLastCalledWith(
    IPC_CHANNELS.scanStateChanged,
    expect.objectContaining({
      historyRevision: 1,
      latestCompleted: expect.objectContaining({ id })
    })
  )
  ack((renderer.send.mock.calls.at(-1)![1] as ScanStateSnapshot).revision)

  storage.deleteSnapshot.mockResolvedValueOnce({
    scanId: id,
    latestCompletedScanId: previous.id,
    latestCompleted: previous
  })
  await invoke(channel, [{ scanId: id }])
  expect(renderer.send).toHaveBeenLastCalledWith(
    IPC_CHANNELS.scanStateChanged,
    expect.objectContaining({
      historyRevision: 2,
      latestCompleted: expect.objectContaining({ id: previous.id })
    })
  )
})

test('authorizes and validates settings requests and suppresses a reply to an invalidated document', async () => {
  let current = { maxCompletedSnapshots: 10 }
  const saved = Promise.withResolvers<void>()
  const retention = {
    getSettings: vi.fn(async () => current),
    setSettings: vi.fn(async (settings: typeof current) => {
      await saved.promise
      current = settings
      return current
    }),
    onPruned: vi.fn(() => () => {})
  }
  await attachWithRecovery(
    Promise.resolve(null),
    retention as NonNullable<Parameters<typeof registerScannerIpc>[4]>
  )
  const { getRetentionSettings, setRetentionSettings } = IPC_CHANNELS
  expect(await invoke(getRetentionSettings, [], event(makeRenderer()))).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  expect(
    await invoke(setRetentionSettings, [{ maxCompletedSnapshots: 4 }], event(makeRenderer()))
  ).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  expect(await invoke(setRetentionSettings, [{ maxCompletedSnapshots: 0 }])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(retention.getSettings).not.toHaveBeenCalled()
  expect(retention.setSettings).not.toHaveBeenCalled()
  expect(await invoke(getRetentionSettings)).toEqual({
    ok: true,
    value: { maxCompletedSnapshots: 10 }
  })
  const reply = invoke(setRetentionSettings, [{ maxCompletedSnapshots: 4 }])
  renderer.emit('destroyed')
  saved.resolve()
  expect(await reply).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  renderer = makeRenderer()
  boundary.attachRenderer(renderer as unknown as WebContents)
  expect(await invoke(getRetentionSettings)).toEqual({
    ok: true,
    value: { maxCompletedSnapshots: 4 }
  })
})

test.each(['navigation', 'destroyed'])(
  'reconciles an admitted deletion after renderer %s',
  async (change) => {
    const saved = completed()
    await attachWithRecovery(Promise.resolve(saved))
    const active = running()
    state = {
      ...active,
      session: { ...active.session, id: 'building' },
      progress: { ...active.progress, scanId: 'building' }
    }
    const pending =
      Promise.withResolvers<Awaited<ReturnType<ScanStorageCoordinator['deleteSnapshot']>>>()
    storage.deleteSnapshot.mockReturnValueOnce(pending.promise)
    const reply = invoke(IPC_CHANNELS.deleteSnapshot, [{ scanId: saved.id }])
    if (change === 'navigation') renderer.emit('did-start-navigation', { isMainFrame: true })
    else renderer.emit('destroyed')
    pending.resolve({ scanId: saved.id, latestCompletedScanId: null, latestCompleted: null })
    expect(await reply).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })

    renderer = makeRenderer()
    boundary.attachRenderer(renderer as unknown as WebContents)
    expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
      ok: true,
      value: {
        historyRevision: 1,
        latestCompleted: null,
        publicationStatus: 'ready',
        state: { session: { id: 'building', status: 'running' } }
      }
    })
    state = { ...running(), session: { ...saved, id: otherId } }
    subscriber(state)
    expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
      ok: true,
      value: { historyRevision: 2, latestCompleted: { id: otherId } }
    })
  }
)

test.each([
  IPC_CHANNELS.getScanSnapshot,
  IPC_CHANNELS.getScanEntry,
  IPC_CHANNELS.listScanDirectory,
  IPC_CHANNELS.getScanDirectoryTreemap,
  IPC_CHANNELS.getInsightsSummary,
  IPC_CHANNELS.getInsightsCategories,
  IPC_CHANNELS.listInsightsExtensions,
  IPC_CHANNELS.listInsightsLargestFiles,
  IPC_CHANNELS.listInsightsLargestDirectories,
  IPC_CHANNELS.getInsightsSizeDistribution,
  IPC_CHANNELS.getInsightsObservations
])(
  'rejects foreign senders, subframes, navigated documents, and shutdown on %s',
  async (channel) => {
    expect(await invoke(channel, [], event(makeRenderer()))).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    expect(
      await invoke(channel, [], { ...event(), senderFrame: { url } } as IpcMainInvokeEvent)
    ).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    renderer.mainFrame.url = 'https://foreign.example'
    expect(await invoke(channel)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    renderer.mainFrame.url = url
    await boundary.dispose()
    expect(await invoke(channel)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(queries.getScanSnapshot).not.toHaveBeenCalled()
    expect(queries.getScanEntry).not.toHaveBeenCalled()
    expect(queries.listScanDirectory).not.toHaveBeenCalled()
    expect(queries.getScanDirectoryTreemap).not.toHaveBeenCalled()
    expect(queries.requireValidatedScan).not.toHaveBeenCalled()
    expect(queries.getInsightsCategories).not.toHaveBeenCalled()
    expect(queries.listInsightsExtensions).not.toHaveBeenCalled()
    expect(queries.listInsightsLargestFiles).not.toHaveBeenCalled()
    expect(queries.listInsightsLargestDirectories).not.toHaveBeenCalled()
    expect(queries.getInsightsSizeDistribution).not.toHaveBeenCalled()
    expect(queries.getInsightsObservations).not.toHaveBeenCalled()
  }
)

test('rejects path access, extra arguments, invalid IDs and unbounded pagination before dispatch', async () => {
  for (const args of [
    [],
    [null],
    [{ scanId: id, entryId: '' }],
    [{ scanId: id, entryId: '../secret' }],
    [{ scanId: id, entryId: otherId, path: rootPath }],
    [{ scanId: id, entryId: otherId }, 'extra']
  ]) {
    expect(await invoke(IPC_CHANNELS.getScanEntry, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  for (const args of [
    [],
    [{ scanId: id, entryId: otherId, offset: -1, limit: 100 }],
    [{ scanId: id, entryId: otherId, offset: 0, limit: 101 }]
  ]) {
    expect(await invoke(IPC_CHANNELS.listScanDirectory, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(await invoke(IPC_CHANNELS.getScanSnapshot, [{}])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(queries.getScanEntry).not.toHaveBeenCalled()
  expect(queries.listScanDirectory).not.toHaveBeenCalled()
})

test('validates Treemap requests before dispatch and preserves structured failures', async () => {
  const valid = { scanId: id, entryId: otherId }
  for (const args of [
    [],
    [null],
    [{ ...valid, entryId: '../folder' }],
    [{ ...valid, scanId: '' }],
    [{ ...valid, path: rootPath }],
    [{ ...valid, offset: 0 }],
    [valid, 'extra'],
    ...[undefined, null, NaN, Infinity, -1, 0, 1.5, 101, '100'].map((limit) => [
      { ...valid, limit }
    ])
  ]) {
    expect(await invoke(IPC_CHANNELS.getScanDirectoryTreemap, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(queries.getScanEntry).not.toHaveBeenCalled()
  expect(queries.getScanDirectoryTreemap).not.toHaveBeenCalled()
  await adoptExplorer(id)
  for (const code of [
    'NOT_DIRECTORY',
    'ENTRY_NOT_FOUND',
    'SIZE_OVERFLOW',
    'SNAPSHOT_EXPIRED',
    'SNAPSHOT_UNAVAILABLE'
  ] as const) {
    queries.getScanDirectoryTreemap.mockRejectedValueOnce(
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        code,
        message: 'Public message',
        sqliteCode: null
      })
    )
    expect(await invoke(IPC_CHANNELS.getScanDirectoryTreemap, [valid])).toEqual({
      ok: false,
      error: { code, message: 'Public message' }
    })
  }
})

test('discards a pending SQLite Treemap response when its renderer navigates', async () => {
  await adoptExplorer(id)
  const request = { scanId: id, entryId: otherId }
  const pending =
    Promise.withResolvers<Awaited<ReturnType<StorageWorkerClient['getScanDirectoryTreemap']>>>()
  queries.getScanDirectoryTreemap.mockReturnValueOnce(pending.promise)
  const received = invoke(IPC_CHANNELS.getScanDirectoryTreemap, [request])
  renderer.emit('did-start-navigation', { isMainFrame: true })
  pending.resolve({
    scanId: id,
    directoryId: otherId,
    entries: [],
    totalCount: 0,
    individualCount: 0,
    unknownCount: 0,
    other: null
  })
  expect(await received).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
})

test('reports storage failure and discards a pending reply after renderer navigation', async () => {
  queries.getScanSnapshot.mockRejectedValueOnce(new StorageUnavailableError())
  expect(await invoke(IPC_CHANNELS.getScanSnapshot)).toMatchObject({
    ok: false,
    error: { code: 'UNAVAILABLE' }
  })
  const pending =
    Promise.withResolvers<Awaited<ReturnType<StorageWorkerClient['getScanSnapshot']>>>()
  queries.getScanSnapshot.mockReturnValueOnce(pending.promise)
  const received = invoke(IPC_CHANNELS.getScanSnapshot)
  renderer.emit('did-start-navigation', { isMainFrame: true })
  pending.resolve({ snapshot: null, unavailable: null })
  expect(await received).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
})

test('serves Insights through one authorized ID-only call on the existing read boundary', async () => {
  const request = { scanId: id }
  for (const args of [
    [],
    [null],
    [request, 'extra'],
    [{ scanId: '../scan' }],
    [{ ...request, path: rootPath }]
  ]) {
    expect(await invoke(IPC_CHANNELS.getInsightsSummary, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(queries.requireValidatedScan).not.toHaveBeenCalled()

  await adoptInsights(id)
  const scan = {
    ...completed(),
    summary: { fileCount: 4, directoryCount: 2, totalBytes: 128, errorCount: 1 }
  }
  queries.requireValidatedScan.mockResolvedValueOnce(scan)
  expect(await invoke(IPC_CHANNELS.getInsightsSummary, [request])).toEqual({
    ok: true,
    value: {
      scanId: id,
      rootPath,
      completedAt: scan.finishedAt,
      summary: scan.summary,
      incomplete: true
    }
  })
  expect(queries.requireValidatedScan).toHaveBeenCalledExactlyOnceWith(id)
  expect(queries.getScanSnapshot).not.toHaveBeenCalled()
})

test('preserves Insights storage errors and hides other database diagnostics', async () => {
  await adoptInsights(id)
  const query = (): Promise<ScannerIpcResult<unknown>> =>
    Promise.resolve(invoke(IPC_CHANNELS.getInsightsSummary, [{ scanId: id }]))
  for (const code of ['SNAPSHOT_UNAVAILABLE', 'SNAPSHOT_EXPIRED'] as const) {
    queries.requireValidatedScan.mockRejectedValueOnce(
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        code,
        message: 'Publication missing',
        sqliteCode: null
      })
    )
    expect(await query()).toEqual({ ok: false, error: { code, message: 'Publication missing' } })
  }
  queries.requireValidatedScan.mockRejectedValueOnce(new StorageUnavailableError())
  expect(await query()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  queries.requireValidatedScan.mockRejectedValueOnce(new Error('private SQLite diagnostics'))
  expect(await query()).toEqual({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'The snapshot request could not be processed.' }
  })
})

test('validates file analytics requests, bounds extension pages and preserves overflow errors', async () => {
  const categoryArgs = { scanId: id }
  const extensionArgs = { scanId: id, offset: 10, limit: 100 }
  const categoryChannel = IPC_CHANNELS.getInsightsCategories
  const extensionChannel = IPC_CHANNELS.listInsightsExtensions
  expect(await invoke(categoryChannel, [{ ...categoryArgs, limit: 10 }])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  for (const args of [
    [{ ...extensionArgs, offset: -1 }],
    [{ ...extensionArgs, limit: 101 }],
    [{ ...extensionArgs, path: rootPath }],
    [extensionArgs, 'extra']
  ]) {
    expect(await invoke(extensionChannel, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(queries.getInsightsCategories).not.toHaveBeenCalled()
  expect(queries.listInsightsExtensions).not.toHaveBeenCalled()
  await adoptInsights(id)
  const common = {
    scanId: id,
    incomplete: false,
    totals: { fileCount: 0, knownBytes: 0, unknownSizeCount: 0 }
  }
  const categories = { ...common, categories: [] }
  const page = { ...common, extensions: [], totalCount: 0, nextOffset: null }
  queries.getInsightsCategories.mockResolvedValueOnce(categories)
  queries.listInsightsExtensions.mockResolvedValueOnce(page)
  expect(await invoke(categoryChannel, [categoryArgs])).toEqual({ ok: true, value: categories })
  expect(await invoke(extensionChannel, [extensionArgs])).toEqual({ ok: true, value: page })
  expect(queries.getInsightsCategories).toHaveBeenCalledExactlyOnceWith(id)
  expect(queries.listInsightsExtensions).toHaveBeenCalledExactlyOnceWith(extensionArgs)

  queries.listInsightsExtensions.mockRejectedValueOnce(
    new StorageWorkerError({
      name: 'SnapshotAccessError',
      code: 'SIZE_OVERFLOW',
      message: 'Size is out of range',
      sqliteCode: null
    })
  )
  expect(await invoke(extensionChannel, [categoryArgs])).toEqual({
    ok: false,
    error: { code: 'SIZE_OVERFLOW', message: 'Size is out of range' }
  })
})

test('discards a pending Insights response after the attached document navigates', async () => {
  await adoptInsights(id)
  const pending = Promise.withResolvers<CompletedScan>()
  queries.requireValidatedScan.mockReturnValueOnce(pending.promise)
  const response = invoke(IPC_CHANNELS.getInsightsSummary, [{ scanId: id }])
  renderer.emit('did-start-navigation', { isMainFrame: true })
  pending.resolve(completed())
  expect(await response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
})

test('requires an adopted Insights selection and rejects replies from earlier generations of the same ID', async () => {
  const read = { scanId: id }
  const result = { scanId: id, incomplete: false, observations: [] }
  await adoptExplorer(id)
  const prepared = await prepareExplicit(id, 'insights')
  for (const channel of [
    IPC_CHANNELS.getInsightsSummary,
    IPC_CHANNELS.getInsightsCategories,
    IPC_CHANNELS.getInsightsSizeDistribution,
    IPC_CHANNELS.getInsightsObservations,
    IPC_CHANNELS.listInsightsExtensions,
    IPC_CHANNELS.listInsightsLargestFiles,
    IPC_CHANNELS.listInsightsLargestDirectories
  ]) {
    expect(await invoke(channel, [read])).toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_UNAVAILABLE' }
    })
  }
  expect(queries.getInsightsObservations).not.toHaveBeenCalled()
  await invoke(IPC_CHANNELS.adoptSnapshotSelection, [{ view: 'insights', ticket: prepared.ticket }])
  expect(await invoke(IPC_CHANNELS.getInsightsObservations, [{ scanId: otherId }])).toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED' }
  })

  const pending = Promise.withResolvers<typeof result>()
  queries.getInsightsObservations.mockReturnValueOnce(pending.promise)
  const old = invoke(IPC_CHANNELS.getInsightsObservations, [read])
  await adoptInsights(otherId)
  await adoptInsights(id)
  pending.resolve(result)
  expect(await old).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })

  const beforeReadoption = Promise.withResolvers<typeof result>()
  queries.getInsightsObservations.mockReturnValueOnce(beforeReadoption.promise)
  const sameId = invoke(IPC_CHANNELS.getInsightsObservations, [read])
  await adoptInsights(id)
  beforeReadoption.resolve(result)
  expect(await sameId).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_EXPIRED' } })

  const beforeRefresh = Promise.withResolvers<typeof result>()
  queries.getInsightsObservations.mockReturnValueOnce(beforeRefresh.promise)
  const current = invoke(IPC_CHANNELS.getInsightsObservations, [read])
  await adoptInsights(id, true)
  beforeRefresh.resolve(result)
  expect(await current).toEqual({ ok: true, value: result })
  const previousDocument = event()
  renderer.emit('did-start-navigation', { isMainFrame: true })
  renderer.mainFrame = { url }
  renderer.emit('did-finish-load')
  expect(
    await invoke(IPC_CHANNELS.getInsightsObservations, [read], previousDocument)
  ).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
})

test('does not issue an Insights adoption ticket for a historical snapshot that fails validation', async () => {
  queries.getScanHistoryMetadata.mockResolvedValueOnce({
    ...completed(),
    durationMs: 1000,
    isLatest: false,
    incomplete: false
  })
  queries.openSavedSnapshot.mockRejectedValueOnce(
    new StorageWorkerError({
      name: 'SnapshotAccessError',
      code: 'SNAPSHOT_UNAVAILABLE',
      message: 'This saved snapshot failed integrity checks.',
      sqliteCode: null
    })
  )
  expect(
    await invoke(IPC_CHANNELS.prepareSnapshotSelection, [
      { view: 'insights', selection: { mode: 'explicit', scanId: id } }
    ])
  ).toEqual({
    ok: false,
    error: {
      code: 'SNAPSHOT_UNAVAILABLE',
      message: 'This saved snapshot failed integrity checks.'
    }
  })
  expect(protection.isProtected(id)).toBe(false)
  expect(await invoke(IPC_CHANNELS.getInsightsSummary, [{ scanId: id }])).toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_UNAVAILABLE' }
  })
})

test('serves observations on the authorized scan channel and aborts stale document replies', async () => {
  const channel = IPC_CHANNELS.getInsightsObservations
  const request = { scanId: id }
  const query = queries.getInsightsObservations
  for (const args of [
    [],
    [null],
    [{ scanId: '../scan' }],
    [{ ...request, path: rootPath }],
    [request, 'extra']
  ]) {
    expect(await invoke(channel, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(query).not.toHaveBeenCalled()
  await adoptInsights(id)
  const result = { scanId: id, incomplete: false, observations: [] }
  query.mockResolvedValueOnce(result)
  expect(await invoke(channel, [request])).toEqual({ ok: true, value: result })
  expect(query).toHaveBeenCalledExactlyOnceWith(id)
  query.mockRejectedValueOnce(
    new StorageWorkerError({
      name: 'SnapshotAccessError',
      code: 'SNAPSHOT_EXPIRED',
      message: 'Observation expired',
      sqliteCode: null
    })
  )
  expect(await invoke(channel, [request])).toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED' }
  })
  const pending = Promise.withResolvers<typeof result>()
  query.mockReturnValueOnce(pending.promise)
  const reply = invoke(channel, [request])
  renderer.emit('did-start-navigation', { isMainFrame: true })
  pending.resolve(result)
  expect(await reply).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
})

test('serves the size distribution over authorized IPC with structured failures and document cancellation', async () => {
  const channel = IPC_CHANNELS.getInsightsSizeDistribution
  const request = { scanId: id }
  const query = queries.getInsightsSizeDistribution
  for (const args of [
    [],
    [null],
    [{ scanId: '../scan' }],
    [{ ...request, limit: 10 }],
    [request, 'extra']
  ]) {
    expect(await invoke(channel, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
  expect(query).not.toHaveBeenCalled()
  await adoptInsights(id)
  const distribution = {
    scanId: id,
    incomplete: false,
    knownSizeCount: 0,
    totals: { fileCount: 0, knownBytes: 0, unknownSizeCount: 0 },
    buckets: INSIGHTS_SIZE_BUCKETS.map(({ id }) => ({ id, fileCount: 0, knownBytes: 0 }))
  }
  query.mockResolvedValueOnce(distribution)
  expect(await invoke(channel, [request])).toEqual({ ok: true, value: distribution })
  expect(query).toHaveBeenCalledExactlyOnceWith(id)

  for (const code of ['SNAPSHOT_UNAVAILABLE', 'SNAPSHOT_EXPIRED', 'SIZE_OVERFLOW'] as const) {
    query.mockRejectedValueOnce(
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        code,
        message: 'Distribution unavailable',
        sqliteCode: null
      })
    )
    expect(await invoke(channel, [request])).toMatchObject({ ok: false, error: { code } })
  }
  query.mockRejectedValueOnce(
    new StorageWorkerError({
      name: 'Error',
      code: null,
      message: 'Persisted totals differ from the published scan summary.',
      sqliteCode: null
    })
  )
  expect(await invoke(channel, [request])).toEqual({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'The snapshot request could not be processed.' }
  })

  const pending = Promise.withResolvers<typeof distribution>()
  query.mockReturnValueOnce(pending.promise)
  const response = invoke(channel, [request])
  renderer.emit('did-start-navigation', { isMainFrame: true })
  pending.resolve(distribution)
  expect(await response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
})

test.each([
  ['listInsightsLargestFiles', 'file'],
  ['listInsightsLargestDirectories', 'directory']
] as const)(
  'validates, authorizes and routes %s through the Insights read context',
  async (operation, type) => {
    const channel = IPC_CHANNELS[operation]
    const query = queries[operation]
    for (const args of [
      [],
      [{ scanId: id, offset: -1 }],
      [{ scanId: id, limit: 21 }],
      [{ scanId: id, path: rootPath }],
      [{ scanId: id }, 'extra']
    ]) {
      expect(await invoke(channel, args)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' }
      })
    }
    expect(query).not.toHaveBeenCalled()
    await adoptInsights(id)
    const page = {
      scanId: id,
      incomplete: true,
      offset: 0,
      limit: 10,
      totalCount: 1,
      nextOffset: null,
      entries: [
        { id: otherId, parentId: 'root', scanId: id, type, name: 'entry', path: rootPath, bytes: 0 }
      ]
    }
    query.mockResolvedValueOnce(page)
    expect(await invoke(channel, [{ scanId: id }])).toEqual({ ok: true, value: page })
    expect(query).toHaveBeenCalledExactlyOnceWith({ scanId: id, offset: 0, limit: 10 })
    query.mockRejectedValueOnce(
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        code: 'SIZE_OVERFLOW',
        message: 'Unsupported ranked size',
        sqliteCode: null
      })
    )
    expect(await invoke(channel, [{ scanId: id }])).toMatchObject({
      ok: false,
      error: { code: 'SIZE_OVERFLOW', message: 'Unsupported ranked size' }
    })
    const pending = Promise.withResolvers<typeof page>()
    query.mockReturnValueOnce(pending.promise)
    const response = invoke(channel, [{ scanId: id }])
    renderer.emit('did-start-navigation', { isMainFrame: true })
    pending.resolve(page)
    expect(await response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  }
)

test.each([
  'SNAPSHOT_UNAVAILABLE',
  'SNAPSHOT_EXPIRED',
  'ENTRY_NOT_FOUND',
  'NOT_DIRECTORY'
] as const)(
  'returns the precise storage outcome %s without exposing internal errors',
  async (code) => {
    await adoptExplorer(id)
    queries.getScanEntry.mockRejectedValueOnce(
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        code,
        message: 'Public message',
        sqliteCode: null
      })
    )
    expect(await invoke(IPC_CHANNELS.getScanEntry, [{ scanId: id, entryId: otherId }])).toEqual({
      ok: false,
      error: { code, message: 'Public message' }
    })
    queries.getScanEntry.mockRejectedValueOnce(new Error('private internals'))
    expect(await invoke(IPC_CHANNELS.getScanEntry, [{ scanId: id, entryId: otherId }])).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'The snapshot request could not be processed.' }
    })
  }
)

test('accepts an approved root promptly, exposes current state, and rejects concurrent starts', async () => {
  await invoke(IPC_CHANNELS.selectScanDirectory)
  const accepted = await invoke(IPC_CHANNELS.startScan, [{ rootPath }])
  expect(accepted).toEqual({ ok: true, value: { scanId: id } })
  expect(accepted).not.toBeInstanceOf(Promise)
  expect(start).toHaveBeenCalledExactlyOnceWith(rootPath, expect.any(Function))
  expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
    ok: true,
    value: { state: { session: { id, status: 'running' } } }
  })
  expect(invoke(IPC_CHANNELS.startScan, [{ rootPath }])).toMatchObject({
    ok: false,
    error: { code: 'SCAN_ACTIVE' }
  })
  settle(state!)
})

test('rejects a storage admission failure without returning a scan ID or exposing internal details', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await invoke(IPC_CHANNELS.selectScanDirectory)
  start.mockRejectedValueOnce(
    new ScanStorageError('starting the scan', new Error('private database path'))
  )
  expect(await invoke(IPC_CHANNELS.startScan, [{ rootPath }])).toEqual({
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'SQLite failed while starting the scan.' }
  })
  expect(state).toBeNull()
  expect(renderer.send).not.toHaveBeenCalled()
})

test('keeps admission pending and rechecks authorization after the building row is ready', async () => {
  await invoke(IPC_CHANNELS.selectScanDirectory)
  const ready = Promise.withResolvers<void>()
  const verify = vi.mocked(verifyScanDirectory)
  start.mockImplementationOnce(async (_path: string, confirmStart: () => Promise<void>) => {
    await ready.promise
    await confirmStart()
    throw new Error('Unexpected admission after navigation')
  })
  const reply = invoke(IPC_CHANNELS.startScan, [{ rootPath }])
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
  expect(verify).toHaveBeenCalledOnce()
  expect(state).toBeNull()
  expect(await invoke(IPC_CHANNELS.startScan, [{ rootPath }])).toMatchObject({
    error: { code: 'SCAN_ACTIVE' }
  })
  renderer.emit('did-start-navigation', { isMainFrame: true })
  ready.resolve()
  expect(await reply).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
  expect(state).toBeNull()
})

test('refuses cancellation during publication and exposes a sanitized uncertain storage outcome', () => {
  state = running()
  cancel.mockReturnValueOnce(false)
  expect(invoke(IPC_CHANNELS.cancelScan, [{ scanId: id }])).toMatchObject({
    ok: false,
    error: { code: 'NOT_RUNNING', message: expect.stringContaining('finishing publication') }
  })
  state = {
    ...state,
    session: { ...state.session, status: 'failed', finishedAt: '2026-11-09T00:01:00Z' },
    failure: { name: 'ScanStorageError', code: 'SCAN_STORAGE_UNCERTAIN', message: 'internal stack' }
  }
  expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
    ok: true,
    value: {
      state: {
        failure: {
          code: 'SCAN_STORAGE_UNCERTAIN',
          message: 'SQLite did not confirm a write. The saved result is unknown.'
        }
      }
    }
  })
})

test.each([
  undefined,
  null,
  [],
  {},
  { rootPath: '' },
  { rootPath: 'relative' },
  { rootPath: 3 },
  { rootPath: rootPath + '\0' },
  { rootPath, extra: true }
])('rejects malformed roots: %j', (payload) => {
  expect(invoke(IPC_CHANNELS.startScan, [payload])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  expect(start).not.toHaveBeenCalled()
})

test.each(['navigation', 'replacement', 'dispose'] as const)(
  'rechecks authorization after pending filesystem validation and rejects %s',
  async (change) => {
    await invoke(IPC_CHANNELS.selectScanDirectory)
    let finish!: (valid: boolean) => void
    vi.mocked(verifyScanDirectory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = invoke(IPC_CHANNELS.startScan, [{ rootPath }])
    if (change === 'navigation') renderer.emit('did-start-navigation', { isMainFrame: true })
    if (change === 'replacement') await invoke(IPC_CHANNELS.selectScanDirectory)
    if (change === 'dispose') await boundary.dispose()
    finish(true)
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: change === 'replacement' ? 'PATH_NOT_AUTHORIZED' : 'UNAVAILABLE' }
    })
    expect(start).not.toHaveBeenCalled()
  }
)

test('rejects argument count errors and malformed cancellation identifiers', () => {
  for (const args of [[], [{ rootPath }, { rootPath }]])
    expect(invoke(IPC_CHANNELS.startScan, args)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  expect(invoke(IPC_CHANNELS.getScanState, [null])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  for (const payload of [null, {}, { scanId: '' }, { scanId: 'old' }, { scanId: id, rootPath }])
    expect(invoke(IPC_CHANNELS.cancelScan, [payload])).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
})

test.runIf(process.platform === 'win32')('rejects Windows drive-relative and device paths', () => {
  for (const rootPath of [
    'C:relative',
    '\\rooted',
    '\\\\?\\C:\\private',
    'C:\\bad*',
    'C:\\CON',
    'C:\\bad.'
  ]) {
    expect(invoke(IPC_CHANNELS.startScan, [{ rootPath }])).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
  }
})

test('requires explicit approval independently of absolute path validation', async () => {
  expect(invoke(IPC_CHANNELS.startScan, [{ rootPath }])).toMatchObject({
    ok: false,
    error: { code: 'PATH_NOT_AUTHORIZED' }
  })
  expect(start).not.toHaveBeenCalled()
  await boundary.dispose()
  vi.mocked(ipcMain.handle).mockClear()
  boundary = registerScannerIpc(manager, url, storage, Promise.resolve(null))
  boundary.attachRenderer(renderer as unknown as WebContents)
  expect(invoke(IPC_CHANNELS.startScan, [{ rootPath }])).toMatchObject({
    ok: false,
    error: { code: 'PATH_NOT_AUTHORIZED' }
  })
})

test('rejects other windows, subframes, null frames, and navigated renderers for every operation', () => {
  const alien = makeRenderer()
  const senders = [
    event(alien),
    { ...event(), senderFrame: { url } },
    { ...event(), senderFrame: null }
  ]
  for (const sender of senders) {
    for (const channel of [
      IPC_CHANNELS.startScan,
      IPC_CHANNELS.getScanState,
      IPC_CHANNELS.cancelScan
    ]) {
      expect(invoke(channel, [], sender as IpcMainInvokeEvent)).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' }
      })
    }
  }
  renderer.mainFrame.url = 'https://attacker.invalid/'
  expect(invoke(IPC_CHANNELS.getScanState)).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED' }
  })
  subscriber(running())
  expect(renderer.send).not.toHaveBeenCalled()
})

test('bounds notifications to one in flight and coalesces the latest pending state', () => {
  subscriber(running())
  const first = renderer.send.mock.calls[0][1] as ScanStateSnapshot
  for (let count = 1; count <= 100; count++) {
    const next = running()
    subscriber({ ...next, progress: { ...next.progress, processedFileCount: count } })
  }
  expect(renderer.send).toHaveBeenCalledOnce()
  ack(first.revision, event(makeRenderer()))
  ack(first.revision + 1)
  expect(renderer.send).toHaveBeenCalledOnce()
  ack(first.revision)
  expect(renderer.send).toHaveBeenCalledTimes(2)
  expect(renderer.send.mock.calls[1][1]).toMatchObject({
    state: { progress: { processedFileCount: 100 } }
  })
  const latest = renderer.send.mock.calls[1][1] as ScanStateSnapshot
  ack(latest.revision)
  expect(renderer.send).toHaveBeenCalledTimes(2)
})

test.each(['completed', 'cancelled', 'failed'] as const)(
  'forwards %s only when the manager reports terminal state',
  async (status) => {
    await invoke(IPC_CHANNELS.selectScanDirectory)
    await invoke(IPC_CHANNELS.startScan, [{ rootPath }])
    const first = renderer.send.mock.calls[0][1] as ScanStateSnapshot
    if (status === 'cancelled') {
      expect(invoke(IPC_CHANNELS.cancelScan, [{ scanId: id }])).toEqual({
        ok: true,
        value: { scanId: id }
      })
      expect(invoke(IPC_CHANNELS.cancelScan, [{ scanId: id }])).toMatchObject({ ok: true })
      expect(state!.session.status).toBe('running')
    }
    state = {
      ...state!,
      session: { ...state!.session, status, finishedAt: '2026-11-09T00:01:00.000Z' }
    }
    subscriber(state)
    ack(first.revision)
    expect(renderer.send.mock.calls.at(-1)![1]).toMatchObject({ state: { session: { status } } })
    expect(invoke(IPC_CHANNELS.cancelScan, [{ scanId: id }])).toMatchObject({
      ok: false,
      error: { code: 'NOT_RUNNING' }
    })
    settle(state)
  }
)

test('stale scan IDs cannot cancel a newer scan', () => {
  state = running()
  state = { ...state, session: { ...state.session, id: otherId } }
  expect(invoke(IPC_CHANNELS.cancelScan, [{ scanId: id }])).toMatchObject({
    ok: false,
    error: { code: 'SCAN_MISMATCH' }
  })
  expect(cancel).not.toHaveBeenCalled()
})

test('sanitizes failure diagnostics and handles thrown requests and rejected background starts', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  state = {
    ...running(),
    failure: { name: 'InternalError', code: 'SECRET', message: 'Secret stack and internal path' }
  }
  const snapshot = invoke(IPC_CHANNELS.getScanState)
  expect(JSON.stringify(snapshot)).not.toMatch(/Secret|SECRET|InternalError/)
  state = null
  await invoke(IPC_CHANNELS.selectScanDirectory)
  await invoke(IPC_CHANNELS.startScan, [{ rootPath }])
  reject(new Error('Internal rejection'))
  await Promise.resolve()
  expect(console.error).toHaveBeenCalled()
  cancel.mockImplementation(() => {
    throw new Error('Private details')
  })
  expect(invoke(IPC_CHANNELS.cancelScan, [{ scanId: id }])).toMatchObject({
    ok: false,
    error: { code: 'INTERNAL_ERROR' }
  })
})

test('state queries have newer revisions than earlier notifications', () => {
  subscriber(running())
  const notification = renderer.send.mock.calls[0][1] as ScanStateSnapshot
  const queried = invoke(IPC_CHANNELS.getScanState)
  expect(queried.ok && (queried.value as ScanStateSnapshot).revision).toBeGreaterThan(
    notification.revision
  )
})

test('handles destroyed windows, reloads, send failures and listener cleanup', async () => {
  renderer.send.mockImplementationOnce(() => {
    throw new Error('Destroyed during send')
  })
  expect(() => subscriber(running())).not.toThrow()
  renderer.emit('did-finish-load')
  expect(renderer.send).toHaveBeenCalledTimes(2)
  renderer.isDestroyed.mockReturnValue(true)
  renderer.emit('destroyed')
  expect(renderer.listenerCount('did-finish-load')).toBe(0)
  expect(() => subscriber(running())).not.toThrow()
  const replacement = makeRenderer()
  boundary.attachRenderer(replacement as unknown as WebContents)
  expect(replacement.send).toHaveBeenCalledOnce()
  await boundary.dispose()
  await boundary.dispose()
  expect(dispose).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(replacement.listenerCount('did-finish-load')).toBe(0)
  expect(replacement.listenerCount('destroyed')).toBe(0)
  expect(ipcMain.listenerCount(IPC_CHANNELS.acknowledgeScanState)).toBe(0)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getScanDirectoryTreemap)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getInsightsSummary)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getInsightsCategories)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.listInsightsExtensions)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.listInsightsLargestFiles)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.listInsightsLargestDirectories)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getInsightsSizeDistribution)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getInsightsObservations)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.listScanHistory)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getScanHistoryMetadata)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.deleteSnapshot)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getRetentionSettings)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.setRetentionSettings)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.prepareSnapshotSelection)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.adoptSnapshotSelection)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.releaseSnapshotSelection)
  expect(ipcMain.removeHandler).toHaveBeenCalledTimes(23)
})

test('shutdown waits for cleanup, handles repeated quit requests and removes its listener', async () => {
  let done!: () => void
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        done = resolve
      })
  )
  registerScannerShutdown(cleanup)
  const quitting = { preventDefault: vi.fn() }
  app.emit('before-quit', quitting)
  app.emit('before-quit', quitting)
  await Promise.resolve()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(app.quit).not.toHaveBeenCalled()
  done()
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
  expect(app.listenerCount('before-quit')).toBe(0)
})

test('preserves the existing application-info handler and rejects extra arguments', () => {
  registerAppInfoHandler(url)
  expect(invoke(IPC_CHANNELS.getAppInfo)).toEqual({
    name: 'SpaceLens',
    version: '0.1.0',
    platform: process.platform
  })
  expect(() => invoke(IPC_CHANNELS.getAppInfo, [null])).toThrow('does not accept')
})
