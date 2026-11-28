import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC_CHANNELS, type ScannerIpcResult } from '../shared/ipc'
import type { StorageDevice, StorageDevicesErrorCode } from '../shared/storage'
import { createStorageDeviceReader, StorageDeviceError } from './storageDevices'

type Result = ScannerIpcResult<readonly StorageDevice[], StorageDevicesErrorCode>

const messages: Record<StorageDevicesErrorCode, string> = {
  UNAUTHORIZED: 'Drive information is only available to the application window.',
  INVALID_REQUEST: 'Drive information requests do not accept arguments.',
  UNSUPPORTED_PLATFORM: 'Drive information is available on Windows.',
  UNAVAILABLE: 'Windows drive information could not be loaded.',
  TIMEOUT: 'Windows drive discovery timed out.'
}

function failure(code: StorageDevicesErrorCode): Result {
  return { ok: false, error: { code, message: messages[code] } }
}

export function registerStorageDevicesHandler(
  rendererUrl: string,
  reader = createStorageDeviceReader()
): {
  attachRenderer: (next: WebContents) => void
  dispose: () => void
} {
  let renderer: WebContents | undefined
  let documentVersion = 0
  let navigating = true

  const committed = (): void => {
    navigating = false
  }
  const invalidated = (): void => {
    documentVersion++
    navigating = true
  }
  const onNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.isSameDocument) invalidated()
  }
  const detach = (): void => {
    renderer?.off('did-start-navigation', onNavigation)
    renderer?.off('did-navigate', committed)
    renderer?.off('render-process-gone', invalidated)
    renderer?.off('destroyed', detach)
    renderer = undefined
    invalidated()
  }

  const authorized = (event: IpcMainInvokeEvent): boolean => {
    try {
      return (
        !navigating &&
        renderer !== undefined &&
        !renderer.isDestroyed() &&
        event.sender === renderer &&
        event.senderFrame === renderer.mainFrame &&
        event.senderFrame.url === rendererUrl
      )
    } catch {
      return false
    }
  }

  ipcMain.handle(
    IPC_CHANNELS.getStorageDevices,
    async (event, ...args: unknown[]): Promise<Result> => {
      if (!authorized(event)) return failure('UNAUTHORIZED')
      if (args.length !== 0) return failure('INVALID_REQUEST')
      const version = documentVersion
      const current = (): boolean => version === documentVersion && authorized(event)
      try {
        const value = await reader.read()
        return current() ? { ok: true, value } : failure('UNAUTHORIZED')
      } catch (error) {
        if (!current()) return failure('UNAUTHORIZED')
        return failure(error instanceof StorageDeviceError ? error.code : 'UNAVAILABLE')
      }
    }
  )

  return {
    attachRenderer: (next) => {
      detach()
      renderer = next
      next.on('did-start-navigation', onNavigation)
      next.on('did-navigate', committed)
      next.on('render-process-gone', invalidated)
      next.on('destroyed', detach)
    },
    dispose: () => {
      detach()
      ipcMain.removeHandler(IPC_CHANNELS.getStorageDevices)
      reader.dispose()
    }
  }
}
