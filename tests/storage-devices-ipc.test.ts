// @vitest-environment node
import { EventEmitter } from 'node:events'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IPC_CHANNELS } from '../src/shared/ipc'
import type { StorageDevice } from '../src/shared/storage'
import { StorageDeviceError } from '../src/main/storageDevices'
import { registerStorageDevicesHandler } from '../src/main/storageDevicesIpc'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

const url = 'file:///spacelens/index.html'
const read = vi.fn<() => Promise<readonly StorageDevice[]>>()
const dispose = vi.fn()

function makeRenderer(): EventEmitter & { mainFrame: { url: string }; isDestroyed: () => boolean } {
  return Object.assign(new EventEmitter(), {
    mainFrame: { url },
    isDestroyed: vi.fn(() => false)
  })
}

let renderer: ReturnType<typeof makeRenderer>
let boundary: ReturnType<typeof registerStorageDevicesHandler>

function event(
  sender = renderer,
  senderFrame: typeof renderer.mainFrame | null = sender.mainFrame
): IpcMainInvokeEvent {
  return { sender, senderFrame } as unknown as IpcMainInvokeEvent
}

function request(requestEvent = event(), ...args: unknown[]): Promise<unknown> {
  const [channel, listener] = vi.mocked(ipcMain.handle).mock.calls[0]
  expect(channel).toBe(IPC_CHANNELS.getStorageDevices)
  return Promise.resolve(listener(requestEvent, ...args))
}

beforeEach(() => {
  vi.clearAllMocks()
  read.mockReset().mockResolvedValue([])
  renderer = makeRenderer()
  boundary = registerStorageDevicesHandler(url, { read, dispose })
  boundary.attachRenderer(renderer as unknown as WebContents)
  renderer.emit('did-navigate')
})
afterEach(() => boundary.dispose())

test('allows only the attached application main frame and argument-free requests', async () => {
  await expect(request()).resolves.toEqual({ ok: true, value: [] })
  await expect(request(event(makeRenderer()))).resolves.toMatchObject({
    error: { code: 'UNAUTHORIZED' }
  })
  await expect(request(event(renderer, { url }))).resolves.toMatchObject({
    error: { code: 'UNAUTHORIZED' }
  })
  await expect(request(event(renderer, null))).resolves.toMatchObject({
    error: { code: 'UNAUTHORIZED' }
  })
  await expect(request(event(), 'C:\\')).resolves.toMatchObject({
    error: { code: 'INVALID_REQUEST' }
  })
  renderer.mainFrame.url = 'file:///other/index.html'
  await expect(request()).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  expect(read).toHaveBeenCalledTimes(1)
})

test('rejects pending reads after main-frame navigation even if the URL and frame object are reused', async () => {
  const pending = Promise.withResolvers<readonly StorageDevice[]>()
  read.mockReturnValueOnce(pending.promise)
  const obsolete = request()
  renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await expect(request()).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  renderer.emit('did-navigate')
  await expect(request()).resolves.toEqual({ ok: true, value: [] })
  pending.resolve([])
  await expect(obsolete).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } })
})

test('keeps the current document authorized through a subframe or same-document navigation', async () => {
  const pending = Promise.withResolvers<readonly StorageDevice[]>()
  read.mockReturnValueOnce(pending.promise)
  const started = request()
  renderer.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  pending.resolve([])
  await expect(started).resolves.toEqual({ ok: true, value: [] })
})

test('sanitizes provider exceptions and keeps the IPC handler available for retry', async () => {
  read.mockRejectedValueOnce(new Error('C:\\private\\diagnostic'))
  await expect(request()).resolves.toEqual({
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'Windows drive information could not be loaded.' }
  })
  read.mockRejectedValueOnce(new StorageDeviceError('TIMEOUT'))
  await expect(request()).resolves.toMatchObject({ error: { code: 'TIMEOUT' } })
  await expect(request()).resolves.toEqual({ ok: true, value: [] })
})

test('rejects late results after renderer destruction and disposes the provider with the handler', async () => {
  const pending = Promise.withResolvers<readonly StorageDevice[]>()
  read.mockReturnValueOnce(pending.promise)
  const pendingResult = request()
  renderer.emit('destroyed')
  pending.resolve([])
  await expect(pendingResult).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  boundary.dispose()
  expect(dispose).toHaveBeenCalledOnce()
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.getStorageDevices)
})
