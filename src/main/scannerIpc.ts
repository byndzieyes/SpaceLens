import {
  app,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { isAbsolute, resolve } from 'node:path'
import {
  IPC_CHANNELS,
  type ScannerIpcErrorCode,
  type ScannerIpcResult,
  type ScanAccepted,
  type ScanStateSnapshot
} from '../shared/ipc'
import type { ScanSessionState } from '../shared/scan'
import type { ScanSessionManager } from './scanner/sessionManager'

function failure(code: ScannerIpcErrorCode, message: string): ScannerIpcResult<never> {
  return { ok: false, error: { code, message } }
}

function singleField(args: unknown[], key: string): string | null {
  if (
    args.length !== 1 ||
    args[0] === null ||
    typeof args[0] !== 'object' ||
    Array.isArray(args[0])
  )
    return null
  const value = args[0] as Record<string, unknown>
  return Object.keys(value).length === 1 && typeof value[key] === 'string' ? value[key] : null
}

function validRoot(path: string): boolean {
  if (
    !path ||
    path.length > 32767 ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    !isAbsolute(path)
  )
    return false
  if (process.platform !== 'win32') return true
  // Require a drive-qualified path or UNC share; reject drive-relative/device paths.
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(path)) return false
  const withoutDrive = path.replace(/^[a-z]:/i, '')
  return (
    !/[<>:"|?*]/.test(withoutDrive) &&
    !withoutDrive
      .split(/[\\/]/)
      .some(
        (part) =>
          part !== '.' &&
          part !== '..' &&
          (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      )
  )
}

function publicState(state: ScanSessionState | null): ScanSessionState | null {
  if (!state) return null
  return {
    session: { ...state.session, summary: { ...state.session.summary } },
    progress: { ...state.progress },
    failure:
      state.failure === null
        ? null
        : {
            name: 'Error',
            code: 'SCAN_FAILED',
            message: 'The scan could not be completed.'
          }
  }
}

/** Main-only approval policy. A well-formed renderer path never grants permission. */
export function registerScannerIpc(
  manager: ScanSessionManager,
  rendererUrl: string,
  isPathAuthorized: (absolutePath: string) => boolean = () => false
): { attachRenderer: (renderer: WebContents) => void; dispose: () => Promise<void> } {
  let renderer: WebContents | null = null
  let disposed = false
  let disposal: Promise<void> | undefined
  let revision = 0
  let latest: ScanStateSnapshot = { revision, state: publicState(manager.getState()) }
  let inFlight: number | null = null

  const authorizedRenderer = (): boolean => {
    try {
      return renderer !== null && !renderer.isDestroyed() && renderer.mainFrame.url === rendererUrl
    } catch {
      return false
    }
  }
  const authorized = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    authorizedRenderer() && event.sender === renderer && event.senderFrame === renderer!.mainFrame

  const capture = (state: ScanSessionState | null): ScanStateSnapshot => {
    if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Scan state revision exhausted.')
    latest = { revision: ++revision, state: publicState(state) }
    return latest
  }
  const sendLatest = (): void => {
    if (disposed || inFlight !== null || !authorizedRenderer()) return
    try {
      inFlight = latest.revision
      renderer!.send(IPC_CHANNELS.scanStateChanged, latest)
    } catch {
      // The renderer may disappear between the liveness check and send.
      inFlight = null
    }
  }
  const unsubscribe = manager.subscribe((state) => {
    capture(state)
    sendLatest()
  })
  const onLoaded = (): void => {
    inFlight = null
    sendLatest()
  }
  const detachRenderer = (): void => {
    renderer?.removeListener('did-finish-load', onLoaded)
    renderer?.removeListener('destroyed', detachRenderer)
    renderer = null
    inFlight = null
  }
  const onAck = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (
      disposed ||
      !authorized(event) ||
      args.length !== 1 ||
      !Number.isSafeInteger(args[0]) ||
      args[0] !== inFlight
    )
      return
    const acknowledged = inFlight
    inFlight = null
    if (latest.revision !== acknowledged) sendLatest()
  }
  ipcMain.on(IPC_CHANNELS.acknowledgeScanState, onAck)

  const channels = [
    IPC_CHANNELS.startScan,
    IPC_CHANNELS.getScanState,
    IPC_CHANNELS.cancelScan
  ] as const
  for (const channel of channels) {
    ipcMain.handle(
      channel,
      (event, ...args: unknown[]): ScannerIpcResult<ScanAccepted | ScanStateSnapshot> => {
        try {
          if (disposed) return failure('UNAVAILABLE', 'Scanner is shutting down.')
          if (!authorized(event))
            return failure('UNAUTHORIZED', 'Scanner access is not authorized.')
          if (channel === IPC_CHANNELS.getScanState) {
            if (args.length !== 0)
              return failure('INVALID_REQUEST', 'getScanState does not accept arguments.')
            return { ok: true, value: capture(manager.getState()) }
          }
          if (channel === IPC_CHANNELS.startScan) {
            const path = singleField(args, 'rootPath')
            if (path === null || !validRoot(path))
              return failure(
                'INVALID_REQUEST',
                'An absolute filesystem directory path is required.'
              )
            const previous = manager.getState()
            if (previous?.session.status === 'running')
              return failure('SCAN_ACTIVE', 'A scan is already active.')
            const rootPath = resolve(path)
            if (!isPathAuthorized(rootPath))
              return failure(
                'PATH_NOT_AUTHORIZED',
                'Choose an approved location before starting a scan.'
              )
            // start() reserves its running session synchronously. Its promise represents
            // terminal settlement, so do not await it in the IPC acceptance response.
            void manager
              .start(rootPath)
              .catch(() => console.error('Scanner start could not settle normally.'))
            const accepted = manager.getState()
            if (
              !accepted ||
              accepted.session.id === previous?.session.id ||
              accepted.session.status !== 'running'
            ) {
              return failure('INTERNAL_ERROR', 'The scan could not be started.')
            }
            return { ok: true, value: { scanId: accepted.session.id } }
          }
          const scanId = singleField(args, 'scanId')
          if (
            scanId === null ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scanId)
          ) {
            return failure('INVALID_REQUEST', 'A valid scan ID is required.')
          }
          const current = manager.getState()
          if (!current || current.session.id !== scanId)
            return failure('SCAN_MISMATCH', 'This scan is no longer current.')
          if (current.session.status !== 'running')
            return failure('NOT_RUNNING', 'This scan is no longer running.')
          manager.cancel()
          return { ok: true, value: { scanId } }
        } catch {
          return failure('INTERNAL_ERROR', 'The scanner request could not be processed.')
        }
      }
    )
  }
  return {
    attachRenderer: (next) => {
      if (disposed) return
      detachRenderer()
      renderer = next
      if (next.isDestroyed()) {
        renderer = null
        return
      }
      next.on('did-finish-load', onLoaded)
      next.on('destroyed', detachRenderer)
      sendLatest()
    },
    dispose: () => {
      if (disposal) return disposal
      disposed = true
      unsubscribe()
      detachRenderer()
      for (const channel of channels) ipcMain.removeHandler(channel)
      ipcMain.removeListener(IPC_CHANNELS.acknowledgeScanState, onAck)
      disposal = manager.dispose()
      return disposal
    }
  }
}

/** Delay app exit until the manager's cooperative cancellation/termination finishes. */
export function registerScannerShutdown(dispose: () => Promise<void>): void {
  let shuttingDown = false
  const onQuit = (event: Electron.Event): void => {
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    void Promise.resolve()
      .then(dispose)
      .catch(() => {
        console.error('Scanner shutdown could not complete normally.')
      })
      .finally(() => {
        app.removeListener('before-quit', onQuit)
        app.quit()
      })
  }
  app.on('before-quit', onQuit)
}
