// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC_CHANNELS, type ScannerIpcResult, type ScanStateSnapshot } from '../src/shared/ipc'
import type { ScanSessionState } from '../src/shared/scan'
import type { ScanSessionManager, ScanSessionSubscriber } from '../src/main/scanner/sessionManager'
import { registerScannerIpc, registerScannerShutdown } from '../src/main/scannerIpc'
import { registerAppInfoHandler } from '../src/main/ipc'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
    app: Object.assign(new EventEmitter(), {
      quit: vi.fn(),
      getName: () => 'SpaceLens',
      getVersion: () => '0.1.0'
    }),
    BrowserWindow: { fromWebContents: vi.fn(() => ({})) }
  }
})

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
let approve: ReturnType<typeof vi.fn<(absolutePath: string) => boolean>>

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

beforeEach(() => {
  vi.clearAllMocks()
  state = null
  renderer = makeRenderer()
  unsubscribe = vi.fn()
  cancel = vi.fn()
  dispose = vi.fn(async () => {})
  approve = vi.fn(() => true)
  start = vi.fn(() => {
    state = running()
    subscriber(state)
    return new Promise<ScanSessionState>((done, fail) => {
      settle = done
      reject = fail
    })
  })
  manager = {
    getState: () => state,
    start,
    cancel,
    dispose,
    subscribe: (callback: ScanSessionSubscriber) => {
      subscriber = callback
      return unsubscribe
    }
  } as unknown as ScanSessionManager
  boundary = registerScannerIpc(manager, url, approve)
  boundary.attachRenderer(renderer as unknown as WebContents)
  ack(0)
  renderer.send.mockClear()
})

afterEach(async () => {
  await boundary.dispose()
  ipcMain.removeAllListeners()
  app.removeAllListeners()
  vi.restoreAllMocks()
})

test('accepts an approved root promptly, exposes current state, and rejects concurrent starts', () => {
  const accepted = invoke(IPC_CHANNELS.startScan, [{ rootPath }])
  expect(accepted).toEqual({ ok: true, value: { scanId: id } })
  expect(accepted).not.toBeInstanceOf(Promise)
  expect(start).toHaveBeenCalledExactlyOnceWith(rootPath)
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
  expect(approve).not.toHaveBeenCalled()
})

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
  approve.mockReturnValue(false)
  expect(invoke(IPC_CHANNELS.startScan, [{ rootPath }])).toMatchObject({
    ok: false,
    error: { code: 'PATH_NOT_AUTHORIZED' }
  })
  expect(start).not.toHaveBeenCalled()
  await boundary.dispose()
  vi.mocked(ipcMain.handle).mockClear()
  boundary = registerScannerIpc(manager, url)
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
  (status) => {
    invoke(IPC_CHANNELS.startScan, [{ rootPath }])
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
  invoke(IPC_CHANNELS.startScan, [{ rootPath }])
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
  expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3)
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
