import { contextBridge } from 'electron'

// No filesystem or IPC capabilities are exposed by the initial scaffold.
const api: Readonly<Record<string, never>> = Object.freeze({})

contextBridge.exposeInMainWorld('api', api)
