export interface StorageDevice {
  readonly id: string
  readonly rootPath: string
  readonly volumeLabel: string | null
  readonly type: 'fixed' | 'removable'
  readonly capacity: StorageDeviceCapacity | null
}

export interface StorageDeviceCapacity {
  /** Decimal strings preserve the full Windows unsigned 64-bit capacity across IPC. */
  readonly totalBytes: string
  readonly freeBytes: string
  readonly usedBytes: string
  readonly usedPercentage: number
}

export type StorageDevicesErrorCode =
  'UNAUTHORIZED' | 'INVALID_REQUEST' | 'UNSUPPORTED_PLATFORM' | 'UNAVAILABLE' | 'TIMEOUT'
