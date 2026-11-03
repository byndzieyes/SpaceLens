import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SpaceLensAPI } from '../shared/ipc'

const api: SpaceLensAPI = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo)
}

contextBridge.exposeInMainWorld('spaceLens', api)
