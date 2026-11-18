import type { FileEntry } from '../../../../shared/scan'
import { knownTreemapBytes, type ScanTreemapOther } from '../../../../shared/snapshot'

interface EntryTile {
  readonly kind: 'entry'
  readonly entry: FileEntry
  /** Null remains distinct from a known zero, including unsupported entry types. */
  readonly bytes: number | null
}

interface OtherTile {
  readonly kind: 'other'
  readonly aggregate: ScanTreemapOther
  readonly bytes: number
}

export type TreemapItem = EntryTile | OtherTile

/** The aggregate key cannot collide with a valid snapshot entry ID. */
export function treemapItemKey(item: TreemapItem): string {
  return item.kind === 'entry' ? item.entry.id : 'Other aggregate'
}

export interface TreemapData {
  readonly directory: FileEntry
  readonly children: readonly EntryTile[]
  readonly other: OtherTile | null
  readonly totalBytes: number
  readonly unknownCount: number
  readonly zeroCount: number
}

/** Only direct children and the excluded-child aggregate contribute to the layout. */
export function createTreemapData(
  directory: FileEntry,
  entries: readonly FileEntry[],
  other: ScanTreemapOther | null = null
): TreemapData {
  if (directory.type !== 'directory') throw new Error('The visualization root must be a directory.')
  const ids = new Set<string>()
  let totalBytes = 0
  let unknownCount = 0
  let zeroCount = 0
  const children = entries.map((entry): EntryTile => {
    if (
      entry.scanId !== directory.scanId ||
      entry.parentId !== directory.id ||
      entry.id === directory.id ||
      ids.has(entry.id)
    )
      throw new Error('Entries must be distinct direct children of this snapshot directory.')
    ids.add(entry.id)
    const bytes = knownTreemapBytes(entry)
    if (bytes === null) unknownCount++
    else {
      if (bytes === 0) zeroCount++
      totalBytes += bytes
      if (!Number.isSafeInteger(totalBytes))
        throw new Error('Known sizes exceed the supported byte total.')
    }
    return { kind: 'entry', entry, bytes }
  })
  if (other) {
    const { count, knownBytes, unknownCount: unknown, zeroCount: zero } = other
    const positive = count - unknown - zero
    if (
      ![count, knownBytes, unknown, zero].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) ||
      count === 0 ||
      positive < 0 ||
      knownBytes < positive ||
      (positive === 0 && knownBytes !== 0)
    )
      throw new Error('Invalid Other aggregate.')
    if (knownBytes > Number.MAX_SAFE_INTEGER - totalBytes)
      throw new Error('Known sizes exceed the supported byte total.')
    totalBytes += knownBytes
    unknownCount += unknown
    zeroCount += zero
  }
  return {
    directory,
    children,
    other: other ? { kind: 'other', aggregate: other, bytes: other.knownBytes } : null,
    totalBytes,
    unknownCount,
    zeroCount
  }
}
