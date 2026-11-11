import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SpaceLensAPI, type ScanStateSnapshot } from '../src/shared/ipc'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: Object.assign(new EventEmitter(), { invoke: vi.fn(), send: vi.fn() })
  }
})

let api: SpaceLensAPI
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  await import('../src/preload/index')
  api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0][1] as SpaceLensAPI
})
afterEach(() => {
  window.dispatchEvent(new Event('unload'))
  vi.restoreAllMocks()
})

function emit(revision: number): void {
  ipcRenderer.emit(
    IPC_CHANNELS.scanStateChanged,
    { secret: 'Electron event' },
    { revision, state: null }
  )
}

test('exposes only the typed application API and uses fixed invoke channels', async () => {
  expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('spaceLens', api)
  expect(Object.keys(api).sort()).toEqual([
    'cancelScan',
    'getAppInfo',
    'getScanState',
    'onScanStateChanged',
    'selectScanDirectory',
    'startScan'
  ])
  const response = { ok: false, error: { code: 'PATH_NOT_AUTHORIZED', message: 'Not approved' } }
  vi.mocked(ipcRenderer.invoke).mockResolvedValue(response)
  expect(await api.startScan({ rootPath: 'C:\\approved' })).toBe(response)
  await api.getScanState()
  await api.cancelScan({ scanId: 'scan-id' })
  await api.getAppInfo()
  await api.selectScanDirectory()
  expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.startScan, {
    rootPath: 'C:\\approved'
  })
  expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, IPC_CHANNELS.getScanState)
  expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, IPC_CHANNELS.cancelScan, {
    scanId: 'scan-id'
  })
  expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(4, IPC_CHANNELS.getAppInfo)
  expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(5, IPC_CHANNELS.selectScanDirectory)
})

test('deduplicates subscribers, strips Electron events, and supports idempotent unsubscription', () => {
  const callback = vi.fn()
  const off = api.onScanStateChanged(callback)
  api.onScanStateChanged(callback)
  expect(ipcRenderer.listenerCount(IPC_CHANNELS.scanStateChanged)).toBe(1)
  emit(1)
  expect(callback).toHaveBeenCalledExactlyOnceWith({ revision: 1, state: null })
  expect(ipcRenderer.send).toHaveBeenLastCalledWith(IPC_CHANNELS.acknowledgeScanState, 1)
  off()
  off()
  emit(2)
  expect(callback).toHaveBeenCalledOnce()
  expect(ipcRenderer.send).toHaveBeenLastCalledWith(IPC_CHANNELS.acknowledgeScanState, 2)
})

test('ignores older revisions and isolates each subscriber snapshot', () => {
  api.onScanStateChanged((snapshot) => {
    Object.assign(snapshot, { revision: 999 })
  })
  const snapshots: ScanStateSnapshot[] = []
  api.onScanStateChanged((snapshot) => snapshots.push(snapshot))
  emit(4)
  emit(2)
  emit(4)
  emit(5)
  expect(snapshots).toEqual([
    { revision: 4, state: null },
    { revision: 5, state: null }
  ])
  expect(ipcRenderer.send).toHaveBeenCalledTimes(4)
})

test('callback failures cannot block acknowledgment or other subscribers', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bad = vi.fn(() => {
    throw new Error('Renderer callback')
  })
  const asyncBad = vi.fn(async () => {
    throw new Error('Async callback')
  })
  const good = vi.fn()
  api.onScanStateChanged(bad)
  api.onScanStateChanged(asyncBad)
  api.onScanStateChanged(good)
  emit(1)
  await Promise.resolve()
  emit(2)
  expect(bad).toHaveBeenCalledOnce()
  expect(asyncBad).toHaveBeenCalledOnce()
  expect(good).toHaveBeenCalledTimes(2)
  expect(ipcRenderer.send).toHaveBeenCalledTimes(2)
})

test('unload releases the single transport listener and subscriptions', () => {
  const callback = vi.fn()
  api.onScanStateChanged(callback)
  window.dispatchEvent(new Event('unload'))
  expect(ipcRenderer.listenerCount(IPC_CHANNELS.scanStateChanged)).toBe(0)
  emit(1)
  expect(callback).not.toHaveBeenCalled()
})
