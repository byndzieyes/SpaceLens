import {
  INSIGHTS_FILE_CATEGORIES,
  INSIGHTS_RANKING_LIMIT,
  INSIGHTS_SIZE_BUCKETS,
  MAX_INSIGHTS_EXTENSION_PAGE_SIZE,
  type InsightsCategories,
  type InsightsCategoryRow,
  type InsightsExtensionPage,
  type InsightsExtensionRequest,
  type InsightsFileBreakdown,
  type InsightsFileTotals,
  type InsightsRankedEntry,
  type InsightsRankingPage,
  type InsightsRankingRequest,
  type InsightsSizeDistribution
} from '../../shared/insights'
import type { FileEntry, ScanSession } from '../../shared/scan'
import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  MAX_SCAN_TREEMAP_ENTRIES,
  knownTreemapBytes,
  type ScanDirectoryPage,
  type ScanDirectoryRequest,
  type ScanDirectoryTreemap,
  type ScanDirectoryTreemapRequest,
  type ScanEntryRequest,
  type ScanSnapshotAvailability
} from '../../shared/snapshot'
import {
  readExtensionRequest,
  readRankingRequest,
  readSnapshotId,
  validateSnapshotRequest,
  validateTreemapRequest
} from './snapshotAccess'
import {
  integer,
  isScanSummary,
  isSnapshotId,
  isStorageEntry,
  isStorageScan,
  nonempty,
  nullableString,
  record,
  validateBuildingScan,
  validateScanPublication,
  validateStorageBatch,
  type BuildingScan,
  type CompletedScan,
  type ScanPublication,
  type StorageBatch
} from './payloads'

interface StorageCommands {
  initialize: { payload: { databasePath: string }; result: null }
  recoverStorage: { payload: null; result: null }
  insertScan: { payload: ScanSession; result: null }
  beginScan: { payload: BuildingScan; result: null }
  publishScan: { payload: ScanPublication; result: CompletedScan }
  discardBuildingScan: { payload: { scanId: string }; result: null }
  getPublishedScan: { payload: null; result: CompletedScan | null }
  requirePublishedScan: { payload: { scanId: string }; result: CompletedScan }
  getInsightsCategories: { payload: { scanId: string }; result: InsightsCategories }
  getInsightsSizeDistribution: { payload: { scanId: string }; result: InsightsSizeDistribution }
  listInsightsExtensions: {
    payload: Required<InsightsExtensionRequest>
    result: InsightsExtensionPage
  }
  listInsightsLargestFiles: {
    payload: Required<InsightsRankingRequest>
    result: InsightsRankingPage
  }
  listInsightsLargestDirectories: {
    payload: Required<InsightsRankingRequest>
    result: InsightsRankingPage
  }
  getScanSnapshot: { payload: null; result: ScanSnapshotAvailability }
  getScanEntry: { payload: ScanEntryRequest; result: FileEntry }
  listScanDirectory: { payload: ScanDirectoryRequest; result: ScanDirectoryPage }
  getScanDirectoryTreemap: { payload: ScanDirectoryTreemapRequest; result: ScanDirectoryTreemap }
  getScan: { payload: { id: string }; result: ScanSession | null }
  insertEntry: { payload: FileEntry; result: null }
  applyBatch: { payload: StorageBatch; result: null }
  getEntry: { payload: { scanId: string; id: string }; result: FileEntry | null }
  close: { payload: null; result: null }
}

export const RECOVERY_CLOSED_CODE = 'RECOVERY_CLOSED'

export type StorageOperation = keyof StorageCommands
export type StoragePayload<T extends StorageOperation> = StorageCommands[T]['payload']
export type StorageResult<T extends StorageOperation> = StorageCommands[T]['result']

export type StorageRequest = {
  [T in StorageOperation]: {
    readonly requestId: number
    readonly operation: T
    readonly payload: StoragePayload<T>
  }
}[StorageOperation]

export interface StorageFailure {
  readonly name: string
  readonly message: string
  readonly code: string | null
  readonly sqliteCode: number | null
}

export type StorageResponse<T extends StorageOperation = StorageOperation> = {
  requestId: number
} & (
  | { readonly ok: true; readonly result: StorageResult<T> }
  | { readonly ok: false; readonly error: StorageFailure }
)

export function storageRequestId(value: unknown): number | undefined {
  if (record(value) && integer(value.requestId) && value.requestId > 0) return value.requestId
  return undefined
}

export function parseStorageRequest(value: unknown): StorageRequest {
  const requestId = storageRequestId(value)
  if (!record(value) || requestId === undefined) throw new TypeError('Invalid storage request ID.')

  const { operation, payload } = value
  switch (operation) {
    case 'initialize':
      if (record(payload) && nonempty(payload.databasePath)) {
        return { requestId, operation, payload: { databasePath: payload.databasePath } }
      }
      break
    case 'insertScan':
      if (isStorageScan(payload)) return { requestId, operation, payload }
      break
    case 'beginScan':
      validateBuildingScan(payload)
      return { requestId, operation, payload }
    case 'publishScan':
      validateScanPublication(payload)
      return { requestId, operation, payload }
    case 'discardBuildingScan':
      if (record(payload) && isSnapshotId(payload.scanId)) {
        return { requestId, operation, payload: { scanId: payload.scanId } }
      }
      break
    case 'recoverStorage':
    case 'getPublishedScan':
    case 'getScanSnapshot':
      if (payload === null) return { requestId, operation, payload }
      break
    case 'requirePublishedScan':
    case 'getInsightsCategories':
    case 'getInsightsSizeDistribution':
      return { requestId, operation, payload: { scanId: readSnapshotId(payload) } }
    case 'listInsightsExtensions':
      return { requestId, operation, payload: readExtensionRequest(payload) }
    case 'listInsightsLargestFiles':
    case 'listInsightsLargestDirectories':
      return { requestId, operation, payload: readRankingRequest(payload) }
    case 'getScanEntry': {
      const request = payload as ScanEntryRequest
      validateSnapshotRequest(request, false)
      return { requestId, operation, payload: request }
    }
    case 'listScanDirectory': {
      const request = payload as ScanDirectoryRequest
      validateSnapshotRequest(request, true)
      return { requestId, operation, payload: request }
    }
    case 'getScanDirectoryTreemap':
      validateTreemapRequest(payload)
      return { requestId, operation, payload }
    case 'getScan':
      if (record(payload) && nonempty(payload.id)) {
        return { requestId, operation, payload: { id: payload.id } }
      }
      break
    case 'insertEntry':
      if (isStorageEntry(payload)) return { requestId, operation, payload }
      break
    case 'applyBatch':
      validateStorageBatch(payload)
      return { requestId, operation, payload }
    case 'getEntry':
      if (record(payload) && nonempty(payload.scanId) && nonempty(payload.id)) {
        return { requestId, operation, payload: { scanId: payload.scanId, id: payload.id } }
      }
      break
    case 'close':
      if (payload === null) return { requestId, operation, payload }
      break
    default:
      throw new TypeError('Unknown storage operation.')
  }
  throw new TypeError(`Invalid payload for storage operation ${operation}.`)
}

function isNull(value: unknown): value is null {
  return value === null
}

function isCompletedScan(value: unknown): value is CompletedScan {
  return isStorageScan(value) && value.status === 'completed'
}

function isSnapshotAvailability(value: unknown): value is ScanSnapshotAvailability {
  if (!record(value) || value.unavailable !== null) return false
  const { snapshot } = value
  if (snapshot === null) return true
  if (!record(snapshot)) return false
  const { entries, root, summary, completedAt, entryCount, incomplete } = snapshot
  return (
    record(entries) &&
    isSnapshotId(entries.scanId) &&
    isSnapshotId(entries.rootEntryId) &&
    isStorageEntry(root) &&
    root.scanId === entries.scanId &&
    root.id === entries.rootEntryId &&
    root.type === 'directory' &&
    root.parentId === null &&
    isScanSummary(summary) &&
    root.aggregatedSizeBytes === summary.totalBytes &&
    nonempty(completedAt) &&
    integer(entryCount) &&
    entryCount - summary.fileCount >= summary.directoryCount &&
    incomplete === summary.errorCount > 0
  )
}

function isDirectoryPage(value: unknown): value is ScanDirectoryPage {
  if (!record(value)) return false
  const { scanId, directoryId, entries, totalCount, nextOffset } = value
  return (
    isSnapshotId(scanId) &&
    isSnapshotId(directoryId) &&
    integer(totalCount) &&
    (nextOffset === null || (integer(nextOffset) && nextOffset < totalCount)) &&
    Array.isArray(entries) &&
    entries.length <= MAX_SCAN_DIRECTORY_PAGE_SIZE &&
    entries.length <= totalCount &&
    Array.from(entries).every(
      (entry) => isStorageEntry(entry) && entry.scanId === scanId && entry.parentId === directoryId
    )
  )
}

function isDirectoryTreemap(value: unknown): value is ScanDirectoryTreemap {
  if (!record(value)) return false
  const { scanId, directoryId, entries, totalCount, individualCount, unknownCount, other } = value
  if (
    !isSnapshotId(scanId) ||
    !isSnapshotId(directoryId) ||
    !integer(totalCount) ||
    !integer(individualCount) ||
    individualCount > Math.min(totalCount, MAX_SCAN_TREEMAP_ENTRIES) ||
    (totalCount > 0 && individualCount === 0) ||
    !integer(unknownCount) ||
    !Array.isArray(entries) ||
    entries.length !== individualCount
  )
    return false

  const ids = new Set<string>()
  let individualUnknown = 0
  let knownBytes = 0
  for (const entry of entries) {
    if (
      !isStorageEntry(entry) ||
      entry.scanId !== scanId ||
      entry.parentId !== directoryId ||
      !isSnapshotId(entry.id) ||
      entry.id === directoryId ||
      ids.has(entry.id)
    )
      return false
    ids.add(entry.id)
    const bytes = knownTreemapBytes(entry)
    if (bytes === null) individualUnknown++
    else {
      if (bytes > Number.MAX_SAFE_INTEGER - knownBytes) return false
      knownBytes += bytes
    }
  }

  const remaining = totalCount - individualCount
  if (remaining === 0) return other === null && unknownCount === individualUnknown
  if (
    !record(other) ||
    other.count !== remaining ||
    !integer(other.unknownCount) ||
    !integer(other.zeroCount) ||
    !integer(other.knownBytes) ||
    other.unknownCount !== unknownCount - individualUnknown
  )
    return false
  const positive = remaining - other.unknownCount - other.zeroCount
  return (
    positive >= 0 &&
    other.knownBytes >= positive &&
    (positive > 0 || other.knownBytes === 0) &&
    other.knownBytes <= Number.MAX_SAFE_INTEGER - knownBytes
  )
}

function isFileTotals(value: unknown): value is InsightsFileTotals {
  return (
    record(value) &&
    integer(value.fileCount) &&
    integer(value.knownBytes) &&
    integer(value.unknownSizeCount) &&
    value.unknownSizeCount <= value.fileCount
  )
}

function isCategoryRow(value: unknown): value is InsightsCategoryRow {
  return (
    record(value) &&
    INSIGHTS_FILE_CATEGORIES.some((category) => category === value.category) &&
    isFileTotals(value) &&
    value.fileCount > 0
  )
}

function isFileBreakdown(value: unknown): value is InsightsFileBreakdown {
  return (
    record(value) &&
    isSnapshotId(value.scanId) &&
    typeof value.incomplete === 'boolean' &&
    isFileTotals(value.totals) &&
    (value.incomplete || value.totals.unknownSizeCount === 0)
  )
}

function isInsightsCategories(value: unknown): value is InsightsCategories {
  if (!record(value) || !isFileBreakdown(value)) return false
  const { categories } = value
  return (
    Array.isArray(categories) &&
    categories.length <= INSIGHTS_FILE_CATEGORIES.length &&
    Array.from(categories).every(isCategoryRow) &&
    new Set(categories.map(({ category }: InsightsCategoryRow) => category)).size ===
      categories.length
  )
}

function isInsightsExtensionPage(value: unknown): value is InsightsExtensionPage {
  if (!record(value) || !isFileBreakdown(value)) return false
  const { extensions, totalCount, nextOffset } = value
  return (
    integer(totalCount) &&
    totalCount <= value.totals.fileCount &&
    Array.isArray(extensions) &&
    extensions.length <= Math.min(MAX_INSIGHTS_EXTENSION_PAGE_SIZE, totalCount) &&
    (nextOffset === null ||
      (integer(nextOffset) &&
        nextOffset >= extensions.length &&
        nextOffset < totalCount &&
        extensions.length > 0)) &&
    Array.from(extensions).every(
      (row) =>
        record(row) &&
        (row.extension === null ||
          (typeof row.extension === 'string' && row.extension.length > 0)) &&
        isCategoryRow(row)
    )
  )
}

function isSizeDistribution(value: unknown): value is InsightsSizeDistribution {
  if (!record(value) || !isFileBreakdown(value)) return false
  const { buckets, knownSizeCount, totals } = value
  if (
    !integer(knownSizeCount) ||
    knownSizeCount !== totals.fileCount - totals.unknownSizeCount ||
    !Array.isArray(buckets) ||
    buckets.length !== INSIGHTS_SIZE_BUCKETS.length
  )
    return false

  let count = 0n
  let bytes = 0n
  for (const [index, bucket] of Array.from(buckets).entries()) {
    const { id } = INSIGHTS_SIZE_BUCKETS[index]
    if (
      !record(bucket) ||
      bucket.id !== id ||
      !integer(bucket.fileCount) ||
      !integer(bucket.knownBytes) ||
      ((id === 'empty' || bucket.fileCount === 0) && bucket.knownBytes !== 0)
    )
      return false
    count += BigInt(bucket.fileCount)
    bytes += BigInt(bucket.knownBytes)
  }
  return count === BigInt(knownSizeCount) && bytes === BigInt(totals.knownBytes)
}

function isRankingPage(
  value: unknown,
  type: InsightsRankedEntry['type']
): value is InsightsRankingPage {
  if (!record(value)) return false
  const { scanId, offset, limit, totalCount, entries, nextOffset, incomplete } = value
  if (
    !isSnapshotId(scanId) ||
    typeof incomplete !== 'boolean' ||
    !integer(offset) ||
    !integer(limit) ||
    limit < 1 ||
    limit > INSIGHTS_RANKING_LIMIT ||
    !integer(totalCount) ||
    totalCount > INSIGHTS_RANKING_LIMIT ||
    !Array.isArray(entries) ||
    entries.length !== Math.min(limit, Math.max(0, totalCount - offset))
  )
    return false
  const next = offset + entries.length
  return (
    nextOffset === (next < totalCount ? next : null) &&
    Array.from(entries).every(
      (row) =>
        record(row) &&
        row.scanId === scanId &&
        row.type === type &&
        isSnapshotId(row.id) &&
        isSnapshotId(row.parentId) &&
        row.parentId !== row.id &&
        typeof row.name === 'string' &&
        nonempty(row.path) &&
        (row.bytes === null || integer(row.bytes))
    )
  )
}

const resultValidators: { [T in StorageOperation]: (value: unknown) => value is StorageResult<T> } =
  {
    initialize: isNull,
    recoverStorage: isNull,
    insertScan: isNull,
    beginScan: isNull,
    publishScan: isCompletedScan,
    discardBuildingScan: isNull,
    getPublishedScan: (value): value is CompletedScan | null =>
      value === null || isCompletedScan(value),
    requirePublishedScan: isCompletedScan,
    getInsightsCategories: isInsightsCategories,
    getInsightsSizeDistribution: isSizeDistribution,
    listInsightsExtensions: isInsightsExtensionPage,
    listInsightsLargestFiles: (value): value is InsightsRankingPage => isRankingPage(value, 'file'),
    listInsightsLargestDirectories: (value): value is InsightsRankingPage =>
      isRankingPage(value, 'directory'),
    getScanSnapshot: isSnapshotAvailability,
    getScanEntry: isStorageEntry,
    listScanDirectory: isDirectoryPage,
    getScanDirectoryTreemap: isDirectoryTreemap,
    getScan: (value): value is ScanSession | null => value === null || isStorageScan(value),
    insertEntry: isNull,
    applyBatch: isNull,
    getEntry: (value): value is FileEntry | null => value === null || isStorageEntry(value),
    close: isNull
  }

function isFailure(value: unknown): value is StorageFailure {
  return (
    record(value) &&
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    nullableString(value.code) &&
    (value.sqliteCode === null || integer(value.sqliteCode))
  )
}

export function parseStorageResponse<T extends StorageOperation>(
  value: unknown,
  requestId: number,
  operation: T
): StorageResponse<T> {
  if (!record(value) || value.requestId !== requestId) {
    throw new Error('Storage worker response does not match the pending request ID.')
  }
  const validate: (result: unknown) => result is StorageResult<T> = resultValidators[operation]
  if (value.ok === true && validate(value.result)) {
    return { requestId, ok: true, result: value.result }
  }
  if (value.ok === false && isFailure(value.error)) {
    return { requestId, ok: false, error: value.error }
  }
  throw new TypeError(`Invalid response for storage operation ${operation}.`)
}

export function serializeStorageFailure(cause: unknown): StorageFailure {
  // ScanDatabase preserves the context of open failures in Error.cause.
  const detail = cause instanceof Error && !('code' in cause) ? cause.cause : cause
  return {
    name: cause instanceof Error ? cause.name : 'Error',
    message: cause instanceof Error ? cause.message : String(cause),
    code: record(detail) && typeof detail.code === 'string' ? detail.code : null,
    sqliteCode: record(detail) && integer(detail.errcode) ? detail.errcode : null
  }
}
