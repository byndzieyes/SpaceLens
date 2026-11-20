import type { FileEntry } from '../../shared/scan'
import { SCANNER_BATCH_SIZE } from '../scanner/workerProtocol'

export type FinalizedDirectory = FileEntry & {
  readonly type: 'directory'
  readonly aggregatedSizeBytes: number
}

export type StorageBatchOperation =
  | { readonly type: 'entry'; readonly entry: FileEntry }
  | { readonly type: 'directory-finalized'; readonly entry: FinalizedDirectory }

export interface StorageBatch {
  readonly scanId: string
  readonly operations: readonly StorageBatchOperation[]
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

export function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export function isStorageEntry(value: unknown): value is FileEntry {
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

/** Empty batches are valid after filtering a scanner batch that only carried errors or a summary. */
export function validateStorageBatch(value: unknown): asserts value is StorageBatch {
  if (!record(value) || !nonempty(value.scanId) || !Array.isArray(value.operations)) {
    throw new TypeError('A storage batch requires a scan ID and an operations array.')
  }
  const operations: readonly unknown[] = value.operations
  if (operations.length > SCANNER_BATCH_SIZE) {
    throw new RangeError(`A storage batch may contain at most ${SCANNER_BATCH_SIZE} operations.`)
  }
  for (const [index, operation] of operations.entries()) {
    if (!record(operation) || !isStorageEntry(operation.entry)) {
      throw new TypeError(`Invalid entry in storage batch operation ${index + 1}.`)
    }
    const { entry, type } = operation
    if (entry.scanId !== value.scanId) {
      throw new TypeError(`Storage batch operation ${index + 1} belongs to a different scan.`)
    }
    if (type === 'entry' && entry.aggregatedSizeBytes === null) continue
    if (
      type === 'directory-finalized' &&
      entry.type === 'directory' &&
      entry.aggregatedSizeBytes !== null
    )
      continue
    throw new TypeError(
      `Invalid discovery or finalization in storage batch operation ${index + 1}.`
    )
  }
}
