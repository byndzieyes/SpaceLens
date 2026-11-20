// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { app, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC_CHANNELS, type ScannerIpcResult, type ScanStateSnapshot } from '../src/shared/ipc'
import type { CompletedScan } from '../src/main/storage/payloads'
import type { ScanSessionState } from '../src/shared/scan'
import type { ScanSessionManager, ScanSessionSubscriber } from '../src/main/scanner/sessionManager'
import { registerScannerIpc, registerScannerShutdown } from '../src/main/scannerIpc'
import { registerAppInfoHandler } from '../src/main/ipc'
import { verifyScanDirectory } from '../src/main/scanner/directoryApproval'
import { ScanStorageError } from '../src/main/scanner/persistence'
import {
  StorageUnavailableError,
  type ScanStorageCoordinator
} from '../src/main/storage/coordinator'
import { StorageWorkerError, type StorageWorkerClient } from '../src/main/storage/workerClient'

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
let manager: ScanSessionManager
let start: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
let dispose: ReturnType<typeof vi.fn>
let unsubscribe: ReturnType<typeof vi.fn>
const queries = {
  getScanSnapshot: vi.fn<StorageWorkerClient['getScanSnapshot']>(),
  getScanEntry: vi.fn<StorageWorkerClient['getScanEntry']>(),
  listScanDirectory: vi.fn<StorageWorkerClient['listScanDirectory']>(),
  getScanDirectoryTreemap: vi.fn<StorageWorkerClient['getScanDirectoryTreemap']>()
}
const storage: Pick<ScanStorageCoordinator, 'read'> = {
  read: async (_signal, query) => query(queries)
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

beforeEach(async () => {
  vi.clearAllMocks()
  for (const query of Object.values(queries)) query.mockReset()
  queries.getScanSnapshot.mockResolvedValue({ snapshot: null, unavailable: null })
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

const completed = (): CompletedScan => ({
  ...running().session,
  status: 'completed',
  finishedAt: '2026-11-12T12:00:00Z'
})

async function attachWithRecovery(publication: Promise<CompletedScan | null>): Promise<void> {
  await boundary.dispose()
  vi.mocked(ipcMain.handle).mockClear()
  boundary = registerScannerIpc(manager, url, storage, publication)
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

test.each([
  IPC_CHANNELS.getScanSnapshot,
  IPC_CHANNELS.getScanEntry,
  IPC_CHANNELS.listScanDirectory,
  IPC_CHANNELS.getScanDirectoryTreemap
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

test.each([
  'SNAPSHOT_UNAVAILABLE',
  'SNAPSHOT_EXPIRED',
  'ENTRY_NOT_FOUND',
  'NOT_DIRECTORY'
] as const)(
  'returns the precise storage outcome %s without exposing internal errors',
  async (code) => {
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
  expect(ipcMain.removeHandler).toHaveBeenCalledTimes(8)
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
