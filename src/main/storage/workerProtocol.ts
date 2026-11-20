import type { FileEntry, ScanSession } from '../../shared/scan'
import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  type ScanDirectoryPage,
  type ScanDirectoryRequest,
  type ScanEntryRequest,
  type ScanSnapshotAvailability
} from '../../shared/snapshot'
import { validateSnapshotRequest } from '../scanner/snapshot'
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
  publishScan: { payload: ScanPublication; result: null }
  discardBuildingScan: { payload: { scanId: string }; result: null }
  getPublishedScan: { payload: null; result: CompletedScan | null }
  getScanSnapshot: { payload: null; result: ScanSnapshotAvailability }
  getScanEntry: { payload: ScanEntryRequest; result: FileEntry }
  listScanDirectory: { payload: ScanDirectoryRequest; result: ScanDirectoryPage }
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

const resultValidators: { [T in StorageOperation]: (value: unknown) => value is StorageResult<T> } =
  {
    initialize: isNull,
    recoverStorage: isNull,
    insertScan: isNull,
    beginScan: isNull,
    publishScan: isNull,
    discardBuildingScan: isNull,
    getPublishedScan: (value): value is CompletedScan | null =>
      value === null || (isStorageScan(value) && value.status === 'completed'),
    getScanSnapshot: isSnapshotAvailability,
    getScanEntry: isStorageEntry,
    listScanDirectory: isDirectoryPage,
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
