import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { basename } from 'node:path'
import type { FileEntry, FileEntryType } from '../../shared/scan'

export function getEntryType(
  stats: Pick<Stats, 'isSymbolicLink' | 'isDirectory' | 'isFile'>
): FileEntryType {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  return 'other'
}

function toTimestamp(milliseconds: number): string | null {
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** Convert lstat metadata; values unavailable in the contract's range remain null. */
export function createFileEntry(
  path: string,
  scanId: string,
  parentId: string | null,
  stats: Stats
): FileEntry {
  const type = getEntryType(stats)

  return {
    id: randomUUID(),
    scanId,
    parentId,
    path,
    // Filesystem roots have no basename (for example / or C:\\).
    name: basename(path) || path,
    type,
    sizeBytes:
      type === 'file' && Number.isSafeInteger(stats.size) && stats.size >= 0 ? stats.size : null,
    aggregatedSizeBytes: null,
    createdAt: toTimestamp(stats.birthtimeMs),
    modifiedAt: toTimestamp(stats.mtimeMs)
  }
}
