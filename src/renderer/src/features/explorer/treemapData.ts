import type { FileEntry } from '../../../../shared/scan'

export interface TreemapItem {
  readonly entry: FileEntry
  /** Null remains distinct from a known zero, including unsupported entry types. */
  readonly bytes: number | null
}

export interface TreemapData {
  readonly directory: FileEntry
  readonly children: readonly TreemapItem[]
  readonly totalBytes: number
  readonly unknownCount: number
  readonly zeroCount: number
}

/** One published directory listing only; the directory's own total is never added. */
export function createTreemapData(
  directory: FileEntry,
  entries: readonly FileEntry[]
): TreemapData {
  if (directory.type !== 'directory') throw new Error('The visualization root must be a directory.')
  const ids = new Set<string>()
  let totalBytes = 0
  let unknownCount = 0
  let zeroCount = 0
  const children = entries.map((entry): TreemapItem => {
    if (
      entry.scanId !== directory.scanId ||
      entry.parentId !== directory.id ||
      entry.id === directory.id ||
      ids.has(entry.id)
    )
      throw new Error('Entries must be distinct direct children of this snapshot directory.')
    ids.add(entry.id)
    const size =
      entry.type === 'file'
        ? entry.sizeBytes
        : entry.type === 'directory'
          ? entry.aggregatedSizeBytes
          : null
    const bytes = size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null
    if (bytes === null) unknownCount++
    else {
      if (bytes === 0) zeroCount++
      totalBytes += bytes
      if (!Number.isSafeInteger(totalBytes))
        throw new Error('Known sizes exceed the supported byte total.')
    }
    return { entry, bytes }
  })
  return { directory, children, totalBytes, unknownCount, zeroCount }
}
