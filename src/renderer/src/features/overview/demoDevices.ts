import type { StorageDevice } from '../../../../shared/storage'

export const demoDevices: readonly StorageDevice[] = [
  {
    id: 'demo-c',
    name: 'Local Disk',
    mountPoint: 'C:',
    totalBytes: 476_000_000_000,
    usedBytes: 382_000_000_000
  },
  {
    id: 'demo-d',
    name: 'Local Disk',
    mountPoint: 'D:',
    totalBytes: 256_000_000_000,
    usedBytes: 128_000_000_000
  }
]
