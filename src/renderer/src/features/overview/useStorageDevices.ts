import { useEffect, useRef, useState, type RefObject } from 'react'
import type { StorageDevice, StorageDevicesErrorCode } from '../../../../shared/storage'

export type StorageDeviceCache = RefObject<readonly StorageDevice[] | null>

type DeviceState =
  | { status: 'loading'; devices: readonly StorageDevice[] | null }
  | { status: 'ready'; devices: readonly StorageDevice[] }
  | { status: 'error'; devices: readonly StorageDevice[] | null; message: string }

function errorMessage(code?: StorageDevicesErrorCode): string {
  switch (code) {
    case 'TIMEOUT':
      return 'Drive discovery timed out.'
    case 'UNSUPPORTED_PLATFORM':
      return 'Drive information is available on Windows.'
    default:
      return 'Drive information could not be loaded.'
  }
}

export function useStorageDevices(
  completedScanId: string | null | undefined,
  cache?: StorageDeviceCache
): { state: DeviceState; refresh: () => void } {
  const [state, setState] = useState<DeviceState>({ status: 'loading', devices: null })
  const request = useRef<((scanCompleted?: boolean) => void) | null>(null)
  const lastScan = useRef<string | null>(undefined)

  useEffect(() => {
    let active = true
    let reading = false
    let refreshAfterScan = false
    let devices = cache?.current ?? null

    const load = async (): Promise<void> => {
      reading = true
      refreshAfterScan = false
      setState({ status: 'loading', devices })
      const current = (): boolean => active && !refreshAfterScan
      try {
        const result = await window.spaceLens.getStorageDevices()
        if (!current()) return
        if (result.ok) {
          devices = result.value
          if (cache) cache.current = devices
          setState({ status: 'ready', devices })
        } else {
          setState({ status: 'error', devices, message: errorMessage(result.error.code) })
        }
      } catch {
        if (current()) setState({ status: 'error', devices, message: errorMessage() })
      } finally {
        reading = false
        if (active && refreshAfterScan) void load()
      }
    }

    request.current = (scanCompleted) => {
      if (!reading) void load()
      else if (scanCompleted) refreshAfterScan = true
    }
    // React Strict Mode can tear down the first setup before it needs to request IPC.
    queueMicrotask(() => {
      if (active && !reading) void load()
    })
    return () => {
      active = false
      request.current = null
    }
  }, [cache])

  useEffect(() => {
    if (completedScanId === undefined) return
    if (lastScan.current !== undefined && completedScanId && lastScan.current !== completedScanId) {
      request.current?.(true)
    }
    lastScan.current = completedScanId
  }, [completedScanId])

  return { state, refresh: () => request.current?.() }
}
