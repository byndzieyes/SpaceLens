import { SCANNER_BATCH_SIZE } from '../src/main/scanner/workerProtocol'
import type { ScanDatabase } from '../src/main/storage/database'
import type {
  BuildingScan,
  CompletedScan,
  StorageBatchOperation
} from '../src/main/storage/payloads'
import type { ComparisonPathStyle } from '../src/shared/comparison'
import type { FileEntry } from '../src/shared/scan'
import type { ScanSnapshot } from '../src/shared/snapshot'

const startedAt = '2026-09-01T13:00:00.000Z'
const finishedAt = '2026-09-01T13:01:00.000Z'
const rootPath = '/comparison'

export interface Spec {
  key: string
  id?: string
  type?: FileEntry['type']
  sizeBytes?: number | null
  modifiedAt?: string | null
  rawPath?: string
}

export function fixture(
  scanId: string,
  specs: readonly Spec[] = [],
  {
    root = rootPath,
    style = 'posix',
    errorCount = 0
  }: {
    root?: string
    style?: ComparisonPathStyle
    errorCount?: number
  } = {}
): { scan: CompletedScan; building: BuildingScan; entries: FileEntry[]; snapshot: ScanSnapshot } {
  const entries = new Map<string, FileEntry>()
  const dirs = new Map<string, number>()
  const separator = style === 'posix' ? '/' : '\\'
  let totalBytes = 0
  let fileCount = 0
  const all: Spec[] = [{ key: '', id: 'root', type: 'directory' }, ...specs]
  for (const [index, spec] of all.entries()) {
    const { key, type = 'file', sizeBytes = 1, modifiedAt = startedAt } = spec
    const parent = key.slice(0, Math.max(0, key.lastIndexOf('/')))
    const id = spec.id ?? scanId + '-' + index
    const entry: FileEntry = {
      id,
      scanId,
      parentId: key === '' ? null : entries.get(parent)!.id,
      name: key === '' ? 'root' : key.slice(key.lastIndexOf('/') + 1),
      path:
        spec.rawPath ??
        (key ? root.replace(/[\\/]$/, '') + separator + key.replaceAll('/', separator) : root),
      type,
      sizeBytes: type === 'file' ? sizeBytes : null,
      aggregatedSizeBytes: null,
      createdAt: startedAt,
      modifiedAt
    }
    entries.set(key, entry)
    if (type === 'directory') dirs.set(id, 0)
    if (type === 'file') {
      fileCount++
      totalBytes += sizeBytes ?? 0
    }
  }
  const ordered = [...entries.values()]
  const results = ordered.map((entry) => ({ ...entry }))
  for (const entry of [...results].reverse()) {
    if (entry.type === 'directory') entry.aggregatedSizeBytes = dirs.get(entry.id)!
    if (entry.parentId !== null) {
      dirs.set(
        entry.parentId,
        dirs.get(entry.parentId)! + (entry.aggregatedSizeBytes ?? entry.sizeBytes ?? 0)
      )
    }
  }
  const building = {
    id: scanId,
    rootPath: root,
    startedAt,
    finishedAt: null,
    status: 'running' as const,
    summary: { fileCount: 0, directoryCount: 0, errorCount: 0, totalBytes: 0 }
  }
  const scan = {
    ...building,
    finishedAt,
    status: 'completed' as const,
    summary: { fileCount, directoryCount: dirs.size, errorCount, totalBytes }
  }
  const snapshot: ScanSnapshot = {
    entries: { scanId, rootEntryId: ordered[0].id },
    root: results[0],
    completedAt: finishedAt,
    summary: scan.summary,
    entryCount: results.length,
    incomplete: errorCount > 0
  }
  return { scan, building, entries: results, snapshot }
}

export function publish(db: ScanDatabase, value: ReturnType<typeof fixture>): void {
  const { scan, building, entries } = value
  db.beginScan(building)
  const operations: StorageBatchOperation[] = entries.map((entry) => ({
    type: 'entry',
    entry: { ...entry, aggregatedSizeBytes: null }
  }))
  for (const entry of [...entries].reverse()) {
    if (entry.type === 'directory') {
      operations.push({
        type: 'directory-finalized',
        entry: { ...entry, type: entry.type, aggregatedSizeBytes: entry.aggregatedSizeBytes! }
      })
    }
  }
  for (let i = 0; i < operations.length; i += SCANNER_BATCH_SIZE)
    db.applyBatch(scan.id, operations.slice(i, i + SCANNER_BATCH_SIZE))
  db.publishScan(scan, entries[0].id)
}
