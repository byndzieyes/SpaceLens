import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { isAbsolute } from 'node:path'
import {
  IPC_CHANNELS,
  type ScannerIpcErrorCode,
  type ScannerIpcResult,
  type ScanAccepted,
  type ScanDirectorySelection,
  type ScanStateSnapshot
} from '../shared/ipc'
import type { ScanSessionState } from '../shared/scan'
import type { ScanDirectoryRequest, ScanEntryRequest } from '../shared/snapshot'
import {
  SnapshotAccessError,
  validateSnapshotRequest,
  validateTreemapRequest
} from './scanner/snapshot'
import type { ScanSessionManager } from './scanner/sessionManager'
import { ScanStorageError } from './scanner/persistence'
import {
  inspectScanDirectory,
  verifyScanDirectory,
  type DirectoryApproval
} from './scanner/directoryApproval'
import { StorageUnavailableError, type ScanStorageCoordinator } from './storage/coordinator'
import { StorageWorkerError } from './storage/workerClient'

function failure(code: ScannerIpcErrorCode, message: string): ScannerIpcResult<never> {
  return { ok: false, error: { code, message } }
}

function snapshotFailure(error: unknown): ScannerIpcResult<never> {
  if (error instanceof SnapshotAccessError) return failure(error.code, error.message)
  if (error instanceof StorageUnavailableError) return failure('UNAVAILABLE', error.message)
  if (error instanceof StorageWorkerError && error.name === 'SnapshotAccessError') {
    switch (error.code) {
      case 'INVALID_REQUEST':
      case 'SNAPSHOT_UNAVAILABLE':
      case 'SNAPSHOT_EXPIRED':
      case 'ENTRY_NOT_FOUND':
      case 'NOT_DIRECTORY':
      case 'SIZE_OVERFLOW':
        return failure(error.code, error.message)
    }
  }
  return failure('INTERNAL_ERROR', 'The snapshot request could not be processed.')
}

class ScanStartRejected extends Error {
  constructor(
    readonly code: ScannerIpcErrorCode,
    message: string
  ) {
    super(message)
  }
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
  const storageCode = state.failure?.name === 'ScanStorageError' ? state.failure.code : null
  const failureCode =
    storageCode === 'SCAN_STORAGE_FAILED' || storageCode === 'SCAN_STORAGE_UNCERTAIN'
      ? storageCode
      : 'SCAN_FAILED'
  const messages = {
    SCAN_FAILED: 'The scan could not be completed.',
    SCAN_STORAGE_FAILED: 'SQLite could not save this scan.',
    SCAN_STORAGE_UNCERTAIN: 'SQLite did not confirm a write. The saved result is unknown.'
  }
  return {
    session: { ...state.session, summary: { ...state.session.summary } },
    progress: { ...state.progress },
    failure:
      state.failure === null
        ? null
        : {
            name: 'Error',
            code: failureCode,
            message: messages[failureCode]
          }
  }
}

/** Only the native picker grants approval, scoped to the attached renderer document. */
export function registerScannerIpc(
  manager: ScanSessionManager,
  rendererUrl: string,
  storage: Pick<ScanStorageCoordinator, 'read'>
): { attachRenderer: (renderer: WebContents) => void; dispose: () => Promise<void> } {
  let renderer: WebContents | null = null
  let disposed = false
  let disposal: Promise<void> | undefined
  let revision = 0
  let latest: ScanStateSnapshot = {
    revision,
    state: publicState(manager.getState()),
    snapshotUnavailable: manager.getSnapshotUnavailable(),
    latestCompleted: manager.getLatestCompleted()
  }
  let inFlight: number | null = null
  let approval: DirectoryApproval | null = null
  let contextVersion = 0
  let pickerBusy = false
  let starting = false
  let explorerContext = new AbortController()

  const clearApproval = (): void => {
    approval = null
    contextVersion++
    explorerContext.abort()
    explorerContext = new AbortController()
  }
  const onNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame) clearApproval()
  }

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
    latest = {
      revision: ++revision,
      state: publicState(state),
      snapshotUnavailable: manager.getSnapshotUnavailable(),
      latestCompleted: manager.getLatestCompleted()
    }
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
    clearApproval()
    renderer?.removeListener('did-start-navigation', onNavigation)
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

  ipcMain.handle(
    IPC_CHANNELS.selectScanDirectory,
    async (event, ...args: unknown[]): Promise<ScannerIpcResult<ScanDirectorySelection>> => {
      if (disposed) return failure('UNAVAILABLE', 'Scanner is shutting down.')
      if (!authorized(event)) return failure('UNAUTHORIZED', 'Scanner access is not authorized.')
      if (args.length !== 0)
        return failure('INVALID_REQUEST', 'selectScanDirectory does not accept arguments.')
      if (pickerBusy) return failure('PICKER_BUSY', 'A directory picker is already open.')
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || owner.isDestroyed())
        return failure('UNAVAILABLE', 'The application window is unavailable.')
      pickerBusy = true
      const version = contextVersion
      const currentContext = (): boolean =>
        !disposed && version === contextVersion && authorized(event) && !owner.isDestroyed()
      try {
        let selection: Electron.OpenDialogReturnValue
        try {
          selection = await dialog.showOpenDialog(owner, {
            title: 'Select a directory to scan',
            properties: ['openDirectory']
          })
        } catch {
          return failure('PICKER_FAILED', 'The directory picker could not be opened.')
        }
        if (!currentContext())
          return failure('UNAVAILABLE', 'The selection context is no longer available.')
        if (selection.canceled) return { ok: true, value: { cancelled: true } }
        if (selection.filePaths.length !== 1 || !validRoot(selection.filePaths[0])) {
          return failure('DIRECTORY_UNAVAILABLE', 'Select an accessible filesystem directory.')
        }
        try {
          const selected = await inspectScanDirectory(selection.filePaths[0])
          if (!currentContext())
            return failure('UNAVAILABLE', 'The selection context is no longer available.')
          if (!validRoot(selected.path))
            return failure('DIRECTORY_UNAVAILABLE', 'Select an accessible filesystem directory.')
          approval = selected
          return { ok: true, value: { cancelled: false, rootPath: selected.path } }
        } catch {
          return failure(
            'DIRECTORY_UNAVAILABLE',
            'The selected directory is unavailable or inaccessible.'
          )
        }
      } finally {
        pickerBusy = false
      }
    }
  )

  const snapshotChannels = [
    IPC_CHANNELS.getScanSnapshot,
    IPC_CHANNELS.getScanEntry,
    IPC_CHANNELS.listScanDirectory,
    IPC_CHANNELS.getScanDirectoryTreemap
  ] as const
  for (const channel of snapshotChannels) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (disposed) return failure('UNAVAILABLE', 'Scanner is shutting down.')
      if (!authorized(event)) return failure('UNAUTHORIZED', 'Scanner access is not authorized.')
      const { signal } = explorerContext
      const reply = <T>(result: ScannerIpcResult<T>): ScannerIpcResult<T> =>
        signal.aborted || !authorized(event)
          ? failure('UNAVAILABLE', 'The Explorer context is no longer available.')
          : result
      try {
        if (channel === IPC_CHANNELS.getScanSnapshot) {
          if (args.length !== 0)
            return failure('INVALID_REQUEST', 'getScanSnapshot does not accept arguments.')
          const value = await storage.read(signal, (client) => client.getScanSnapshot())
          return reply({ ok: true, value })
        }
        if (args.length !== 1)
          return failure('INVALID_REQUEST', 'One snapshot request is required.')
        if (channel === IPC_CHANNELS.getScanDirectoryTreemap) {
          const request = args[0]
          validateTreemapRequest(request)
          const { scanId, entryId } = request
          const value = await storage.read(signal, async (client) => {
            const entry = await client.getScanEntry({ scanId, entryId })
            if (signal.aborted) throw new StorageUnavailableError()
            if (entry.type !== 'directory') {
              throw new SnapshotAccessError('NOT_DIRECTORY', 'Entry is not a directory.')
            }
            // The SQLite entry check and the same-scan memory lookup share one turn in the queue.
            try {
              return manager.getScanDirectoryTreemap(request)
            } catch (error) {
              if (
                error instanceof SnapshotAccessError &&
                (error.code === 'SNAPSHOT_UNAVAILABLE' || error.code === 'SNAPSHOT_EXPIRED')
              ) {
                throw new SnapshotAccessError(
                  'SNAPSHOT_UNAVAILABLE',
                  'Treemap is temporarily unavailable for this saved snapshot. Directory browsing is available.'
                )
              }
              throw error
            }
          })
          return reply({ ok: true, value })
        }
        const request = args[0] as ScanEntryRequest | ScanDirectoryRequest
        validateSnapshotRequest(request, channel === IPC_CHANNELS.listScanDirectory)
        if (channel === IPC_CHANNELS.getScanEntry) {
          const value = await storage.read(signal, (client) => client.getScanEntry(request))
          return reply({ ok: true, value })
        }
        const value = await storage.read(signal, (client) =>
          client.listScanDirectory(request as ScanDirectoryRequest)
        )
        return reply({ ok: true, value })
      } catch (error) {
        return reply(snapshotFailure(error))
      }
    })
  }

  const channels = [
    IPC_CHANNELS.startScan,
    IPC_CHANNELS.getScanState,
    IPC_CHANNELS.cancelScan
  ] as const
  for (const channel of channels) {
    ipcMain.handle(
      channel,
      (
        event,
        ...args: unknown[]
      ):
        | ScannerIpcResult<ScanAccepted | ScanStateSnapshot>
        | Promise<ScannerIpcResult<ScanAccepted>> => {
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
            if (!approval || path !== approval.path)
              return failure(
                'PATH_NOT_AUTHORIZED',
                'Choose an approved location before starting a scan.'
              )
            if (starting) return failure('SCAN_ACTIVE', 'A scan start is already pending.')
            const selected = approval
            const version = contextVersion
            starting = true
            const confirmStart = async (): Promise<void> => {
              let valid = false
              try {
                valid = await verifyScanDirectory(selected)
              } catch {
                /* Unavailable locations revoke their approval. */
              }
              if (disposed || version !== contextVersion || !authorized(event))
                throw new ScanStartRejected(
                  'UNAVAILABLE',
                  'The scan context is no longer available.'
                )
              if (approval !== selected)
                throw new ScanStartRejected(
                  'PATH_NOT_AUTHORIZED',
                  'Select the directory again before scanning.'
                )
              if (!valid) {
                approval = null
                throw new ScanStartRejected(
                  'DIRECTORY_UNAVAILABLE',
                  'The selected directory changed or is no longer accessible. Select it again.'
                )
              }
            }
            return (async (): Promise<ScannerIpcResult<ScanAccepted>> => {
              try {
                await confirmStart()
                if (manager.getState()?.session.status === 'running')
                  return failure('SCAN_ACTIVE', 'A scan is already active.')
                const { scanId, done } = await manager.launch(selected.path, confirmStart)
                void done.catch(() => console.error('Scanner start could not settle normally.'))
                return { ok: true, value: { scanId } }
              } catch (error) {
                if (error instanceof ScanStartRejected) return failure(error.code, error.message)
                if (error instanceof ScanStorageError) {
                  console.error('Scan persistence could not start.', error)
                  return failure('UNAVAILABLE', error.message)
                }
                if (disposed) return failure('UNAVAILABLE', 'Scanner is shutting down.')
                return failure('INTERNAL_ERROR', 'The scan could not be started.')
              } finally {
                starting = false
              }
            })()
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
          if (!manager.cancel()) {
            return failure(
              'NOT_RUNNING',
              'The scan is finishing publication and can no longer be cancelled.'
            )
          }
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
      next.on('did-start-navigation', onNavigation)
      next.on('destroyed', detachRenderer)
      sendLatest()
    },
    dispose: () => {
      if (disposal) return disposal
      disposed = true
      unsubscribe()
      detachRenderer()
      for (const channel of channels) ipcMain.removeHandler(channel)
      for (const channel of snapshotChannels) ipcMain.removeHandler(channel)
      ipcMain.removeHandler(IPC_CHANNELS.selectScanDirectory)
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
