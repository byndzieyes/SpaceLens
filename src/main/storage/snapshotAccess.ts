import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  MAX_SCAN_TREEMAP_ENTRIES,
  type ScanDirectoryRequest,
  type ScanDirectoryTreemapRequest,
  type ScanEntryRequest,
  type SnapshotAccessErrorCode
} from '../../shared/snapshot'
import { integer, isSnapshotId } from './payloads'

export class SnapshotAccessError extends Error {
  constructor(
    readonly code: SnapshotAccessErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SnapshotAccessError'
  }
}

/** Shared by Main callers and IPC; exact keys prevent accidental path-based requests. */
export function validateSnapshotRequest(
  request: ScanEntryRequest | ScanDirectoryRequest,
  directory: boolean
): void {
  const keys = directory ? ['scanId', 'entryId', 'offset', 'limit'] : ['scanId', 'entryId']
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(request, key)) ||
    !isSnapshotId(request.scanId) ||
    !isSnapshotId(request.entryId) ||
    (directory &&
      (!integer((request as ScanDirectoryRequest).offset) ||
        !integer((request as ScanDirectoryRequest).limit) ||
        (request as ScanDirectoryRequest).limit < 1 ||
        (request as ScanDirectoryRequest).limit > MAX_SCAN_DIRECTORY_PAGE_SIZE))
  )
    throw new SnapshotAccessError(
      'INVALID_REQUEST',
      'Valid snapshot IDs and bounded pagination are required.'
    )
}

export function validateTreemapRequest(
  request: unknown
): asserts request is ScanDirectoryTreemapRequest {
  if (request && typeof request === 'object' && !Array.isArray(request)) {
    const fields = request as Record<string, unknown>
    const hasLimit = Object.hasOwn(fields, 'limit')
    if (
      Object.keys(fields).length === (hasLimit ? 3 : 2) &&
      Object.hasOwn(fields, 'scanId') &&
      isSnapshotId(fields.scanId) &&
      Object.hasOwn(fields, 'entryId') &&
      isSnapshotId(fields.entryId) &&
      (!hasLimit ||
        (integer(fields.limit) && fields.limit >= 1 && fields.limit <= MAX_SCAN_TREEMAP_ENTRIES))
    )
      return
  }
  throw new SnapshotAccessError(
    'INVALID_REQUEST',
    `Valid snapshot IDs and an optional Treemap limit from 1 to ${MAX_SCAN_TREEMAP_ENTRIES} are required.`
  )
}
