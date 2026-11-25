import {
  DEFAULT_INSIGHTS_EXTENSION_PAGE_SIZE,
  DEFAULT_INSIGHTS_RANKING_PAGE_SIZE,
  INSIGHTS_RANKING_LIMIT,
  MAX_INSIGHTS_EXTENSION_PAGE_SIZE,
  type InsightsExtensionRequest,
  type InsightsRankingRequest
} from '../../shared/insights'
import {
  MAX_SCAN_DIRECTORY_PAGE_SIZE,
  MAX_SCAN_TREEMAP_ENTRIES,
  type ScanDirectoryRequest,
  type ScanDirectoryTreemapRequest,
  type ScanEntryRequest,
  type SnapshotAccessErrorCode
} from '../../shared/snapshot'
import { integer, isSnapshotId, record } from './payloads'

export class SnapshotAccessError extends Error {
  constructor(
    readonly code: SnapshotAccessErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SnapshotAccessError'
  }
}

export function readSnapshotId(request: unknown): string {
  if (
    record(request) &&
    Object.keys(request).length === 1 &&
    Object.hasOwn(request, 'scanId') &&
    isSnapshotId(request.scanId)
  ) {
    return request.scanId
  }
  throw new SnapshotAccessError('INVALID_REQUEST', 'A valid snapshot scan ID is required.')
}

export function readScanHistoryQuery(request: unknown): ResolvedScanHistoryQuery {
  const query = resolveScanHistoryQuery(request)
  if (query) return query
  throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid scan history query.')
}

export function readExtensionRequest(request: unknown): Required<InsightsExtensionRequest> {
  return readInsightsPage(
    request,
    DEFAULT_INSIGHTS_EXTENSION_PAGE_SIZE,
    MAX_INSIGHTS_EXTENSION_PAGE_SIZE
  )
}

export function readRankingRequest(request: unknown): Required<InsightsRankingRequest> {
  return readInsightsPage(request, DEFAULT_INSIGHTS_RANKING_PAGE_SIZE, INSIGHTS_RANKING_LIMIT)
}

function readInsightsPage(
  request: unknown,
  defaultLimit: number,
  maxLimit: number
): { scanId: string; offset: number; limit: number } {
  if (
    record(request) &&
    Object.keys(request).every((key) => key === 'scanId' || key === 'offset' || key === 'limit') &&
    Object.hasOwn(request, 'scanId') &&
    isSnapshotId(request.scanId)
  ) {
    const offset = Object.hasOwn(request, 'offset') ? request.offset : 0
    const limit = Object.hasOwn(request, 'limit') ? request.limit : defaultLimit
    if (integer(offset) && integer(limit) && limit >= 1 && limit <= maxLimit) {
      return { scanId: request.scanId, offset, limit }
    }
  }
  throw new SnapshotAccessError(
    'INVALID_REQUEST',
    `A scan ID and pagination with a limit from 1 to ${maxLimit} are required.`
  )
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
import { resolveScanHistoryQuery, type ResolvedScanHistoryQuery } from '../../shared/history'
