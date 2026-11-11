import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SpaceLensAPI, type ScanStateSnapshot } from '../shared/ipc'

const subscribers = new Set<(snapshot: ScanStateSnapshot) => void>()
let latestRevision = -1
const onState = (_event: Electron.IpcRendererEvent, snapshot: ScanStateSnapshot): void => {
  try {
    if (snapshot.revision <= latestRevision) return
    latestRevision = snapshot.revision
    for (const callback of [...subscribers]) {
      if (!subscribers.has(callback)) continue
      try {
        const returned: unknown = callback(structuredClone(snapshot))
        if (
          returned !== null &&
          typeof returned === 'object' &&
          'then' in returned &&
          typeof returned.then === 'function'
        ) {
          subscribers.delete(callback)
          void Promise.resolve(returned).catch(() => console.error('Scan state callback failed.'))
        }
      } catch {
        subscribers.delete(callback)
        console.error('Scan state callback removed after failure.')
      }
    }
  } finally {
    ipcRenderer.send(IPC_CHANNELS.acknowledgeScanState, snapshot.revision)
  }
}
ipcRenderer.on(IPC_CHANNELS.scanStateChanged, onState)
globalThis.addEventListener(
  'unload',
  () => {
    ipcRenderer.removeListener(IPC_CHANNELS.scanStateChanged, onState)
    subscribers.clear()
  },
  { once: true }
)

const api: SpaceLensAPI = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  selectScanDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.selectScanDirectory),
  startScan: (request) => ipcRenderer.invoke(IPC_CHANNELS.startScan, request),
  getScanState: () => ipcRenderer.invoke(IPC_CHANNELS.getScanState),
  cancelScan: (request) => ipcRenderer.invoke(IPC_CHANNELS.cancelScan, request),
  onScanStateChanged: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A scan state callback is required.')
    subscribers.add(callback)
    return () => {
      subscribers.delete(callback)
    }
  }
}

contextBridge.exposeInMainWorld('spaceLens', api)
