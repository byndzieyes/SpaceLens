import type { FileEntry, ScanSession } from '../../shared/scan'

interface StorageCommands {
  initialize: { payload: { databasePath: string }; result: null }
  insertScan: { payload: ScanSession; result: null }
  getScan: { payload: { id: string }; result: ScanSession | null }
  insertEntry: { payload: FileEntry; result: null }
  getEntry: { payload: { scanId: string; id: string }; result: FileEntry | null }
  close: { payload: null; result: null }
}

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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function scan(value: unknown): value is ScanSession {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.rootPath)) return false
  const { status, summary, startedAt, finishedAt } = value
  return (
    typeof startedAt === 'string' &&
    (status === 'running'
      ? finishedAt === null
      : (status === 'completed' || status === 'cancelled' || status === 'failed') &&
        typeof finishedAt === 'string') &&
    record(summary) &&
    integer(summary.fileCount) &&
    integer(summary.directoryCount) &&
    integer(summary.totalBytes) &&
    integer(summary.errorCount)
  )
}

function entry(value: unknown): value is FileEntry {
  if (!record(value)) return false
  const { id, scanId, parentId, path, name, type, createdAt, modifiedAt } = value
  return (
    nonempty(id) &&
    nonempty(scanId) &&
    (parentId === null || nonempty(parentId)) &&
    nonempty(path) &&
    typeof name === 'string' &&
    (type === 'file' ||
      type === 'directory' ||
      type === 'symlink' ||
      type === 'other' ||
      type === 'unknown') &&
    (value.sizeBytes === null || (type === 'file' && integer(value.sizeBytes))) &&
    (value.aggregatedSizeBytes === null ||
      (type === 'directory' && integer(value.aggregatedSizeBytes))) &&
    nullableString(createdAt) &&
    nullableString(modifiedAt)
  )
}

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
      if (scan(payload)) return { requestId, operation, payload }
      break
    case 'getScan':
      if (record(payload) && nonempty(payload.id)) {
        return { requestId, operation, payload: { id: payload.id } }
      }
      break
    case 'insertEntry':
      if (entry(payload)) return { requestId, operation, payload }
      break
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

const resultValidators: { [T in StorageOperation]: (value: unknown) => value is StorageResult<T> } =
  {
    initialize: isNull,
    insertScan: isNull,
    getScan: (value): value is ScanSession | null => value === null || scan(value),
    insertEntry: isNull,
    getEntry: (value): value is FileEntry | null => value === null || entry(value),
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
