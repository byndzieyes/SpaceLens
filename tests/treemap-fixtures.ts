import type { FileEntry } from '../src/shared/scan'
import {
  knownTreemapBytes,
  type ScanDirectoryPage,
  type ScanDirectoryTreemap
} from '../src/shared/snapshot'

export const treemapRoot: FileEntry = {
  id: 'root',
  scanId: 'published',
  parentId: null,
  name: 'Root',
  path: '/root',
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 4000,
  createdAt: null,
  modifiedAt: null
}
export const treemapFile: FileEntry = {
  ...treemapRoot,
  id: 'file',
  parentId: 'root',
  name: 'report.txt',
  path: '/root/report.txt',
  type: 'file',
  sizeBytes: 1000,
  aggregatedSizeBytes: null
}
export const treemapFolder: FileEntry = {
  ...treemapRoot,
  id: 'folder',
  parentId: 'root',
  name: 'Documents',
  path: '/root/Documents',
  aggregatedSizeBytes: 3000
}
export function treemapPage(
  entries: readonly FileEntry[] = [treemapFile, treemapFolder],
  extra: Partial<ScanDirectoryPage> = {}
): ScanDirectoryPage {
  return {
    scanId: 'published',
    directoryId: 'root',
    entries,
    totalCount: entries.length,
    nextOffset: null,
    ...extra
  }
}

export function treemapSummary(
  entries: readonly FileEntry[] = [treemapFile, treemapFolder],
  extra: Partial<ScanDirectoryTreemap> = {}
): ScanDirectoryTreemap {
  return {
    scanId: 'published',
    directoryId: 'root',
    entries,
    totalCount: entries.length,
    individualCount: entries.length,
    unknownCount: entries.filter((entry) => knownTreemapBytes(entry) === null).length,
    other: null,
    ...extra
  }
}
