export interface StorageDevice {
  readonly id: string
  readonly name: string
  /** Drive letter or mount location, for example C: or /Volumes/Data. */
  readonly mountPoint: string
  readonly totalBytes: number
  readonly usedBytes: number
}
