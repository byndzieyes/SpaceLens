import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import type {
  StorageDevice,
  StorageDeviceCapacity,
  StorageDevicesErrorCode
} from '../shared/storage'

const DRIVE_QUERY_TIMEOUT_MS = 5_000
const UINT64_MAX = 18_446_744_073_709_551_615n
const DRIVE_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$drives = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 2 OR DriveType = 3' -Property DeviceID, DriveType, VolumeName, Size, FreeSpace | ForEach-Object {
  @{
    id = $_.DeviceID
    type = $_.DriveType
    label = $_.VolumeName
    total = $(if ($null -ne $_.Size) { $_.Size.ToString([Globalization.CultureInfo]::InvariantCulture) })
    free = $(if ($null -ne $_.FreeSpace) { $_.FreeSpace.ToString([Globalization.CultureInfo]::InvariantCulture) })
  }
})
ConvertTo-Json -InputObject $drives -Compress
`.trim()

type ProviderErrorCode = Exclude<StorageDevicesErrorCode, 'UNAUTHORIZED' | 'INVALID_REQUEST'>

export class StorageDeviceError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code)
  }
}

function readByteCount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null
  const bytes = BigInt(value)
  return bytes <= UINT64_MAX ? bytes : null
}

export function readDriveCapacity(
  totalValue: unknown,
  freeValue: unknown
): StorageDeviceCapacity | null {
  const totalBytes = readByteCount(totalValue)
  const freeBytes = readByteCount(freeValue)
  if (totalBytes === null || freeBytes === null || freeBytes > totalBytes) return null
  const usedBytes = totalBytes - freeBytes
  // Convert only the rounded ratio to Number. All byte arithmetic stays exact.
  const usedPercentage =
    totalBytes === 0n ? 0 : Number((usedBytes * 1_000n + totalBytes / 2n) / totalBytes) / 10
  return {
    totalBytes: totalBytes.toString(),
    freeBytes: freeBytes.toString(),
    usedBytes: usedBytes.toString(),
    usedPercentage
  }
}

function readStorageDevices(output: string): readonly StorageDevice[] {
  const rows: unknown = JSON.parse(output)
  if (!Array.isArray(rows) || rows.length > 26) throw new StorageDeviceError('UNAVAILABLE')
  const devices = new Map<string, StorageDevice>()
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== 'object') throw new StorageDeviceError('UNAVAILABLE')
    const { id, type, label, total, free } = row as Record<string, unknown>
    if (type !== 2 && type !== 3) {
      if (typeof type === 'number' && Number.isInteger(type) && type >= 0 && type <= 6) continue
      throw new StorageDeviceError('UNAVAILABLE')
    }
    if (typeof id !== 'string' || !/^[A-Z]:$/i.test(id)) {
      throw new StorageDeviceError('UNAVAILABLE')
    }
    if (label !== null && typeof label !== 'string') throw new StorageDeviceError('UNAVAILABLE')
    const driveId = id.toUpperCase()
    if (devices.has(driveId)) throw new StorageDeviceError('UNAVAILABLE')
    devices.set(driveId, {
      id: driveId,
      rootPath: `${driveId}\\`,
      volumeLabel: label?.trim() ? label : null,
      type: type === 3 ? 'fixed' : 'removable',
      capacity: readDriveCapacity(total, free)
    })
  }
  return [...devices.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function queryWindowsDrives(signal: AbortSignal): Promise<readonly StorageDevice[]> {
  const systemRoot = process.env['SystemRoot']
  if (!systemRoot || !/^[A-Z]:[\\/]/i.test(systemRoot)) {
    return Promise.reject(new StorageDeviceError('UNAVAILABLE'))
  }
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  return new Promise((resolve, reject) => {
    execFile(
      win32.join(powershell, 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DRIVE_QUERY],
      {
        cwd: powershell,
        env: { ...process.env, PSModulePath: win32.join(powershell, 'Modules') },
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: DRIVE_QUERY_TIMEOUT_MS,
        windowsHide: true,
        signal
      },
      (error, stdout) => {
        if (error) {
          const timedOut = error.killed && error.code === null && !signal.aborted
          reject(new StorageDeviceError(timedOut ? 'TIMEOUT' : 'UNAVAILABLE'))
          return
        }
        try {
          resolve(readStorageDevices(stdout))
        } catch {
          reject(new StorageDeviceError('UNAVAILABLE'))
        }
      }
    )
  })
}

export function createStorageDeviceReader(platform: NodeJS.Platform = process.platform): {
  read: () => Promise<readonly StorageDevice[]>
  dispose: () => void
} {
  const lifetime = new AbortController()
  let pending: Promise<readonly StorageDevice[]> | undefined
  return {
    read: () => {
      if (platform !== 'win32') {
        return Promise.reject(new StorageDeviceError('UNSUPPORTED_PLATFORM'))
      }
      if (lifetime.signal.aborted) return Promise.reject(new StorageDeviceError('UNAVAILABLE'))
      pending ??= queryWindowsDrives(lifetime.signal).finally(() => {
        pending = undefined
      })
      return pending
    },
    dispose: () => lifetime.abort()
  }
}
