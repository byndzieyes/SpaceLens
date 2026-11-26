import {
  DEFAULT_COMPARISON_PAGE_SIZE,
  MAX_COMPARISON_PAGE_SIZE,
  type ComparisonCoverage,
  type ComparisonFilePage,
  type ComparisonFileQuery,
  type ComparisonPathObservation,
  type EntryChangeKind,
  type FileChangeClassification
} from '../../shared/comparison'
import { isComparisonPathKey } from '../comparison/paths'
import { isCompatiblePair, type CompatiblePair } from './comparisonMatchContracts'
import { integer, isSnapshotId, nullableString, record } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'

export type ComparisonFileResult = ComparisonFilePage & { readonly compatibility: CompatiblePair }

export type ResolvedComparisonFileQuery = ComparisonFileQuery &
  Required<Pick<ComparisonFileQuery, 'limit' | 'offset' | 'sort'>>

const reasons: Readonly<Record<EntryChangeKind, readonly FileChangeClassification['reason'][]>> = {
  added: ['confirmed-absence', 'type-replacement'],
  removed: ['confirmed-absence', 'type-replacement'],
  modified: ['size-changed', 'modified-time-changed', 'size-and-modified-time-changed'],
  unchanged: ['metadata-equal'],
  indeterminate: ['unknown-presence', 'unknown-entry-type', 'unknown-metadata']
}

function isChangeKind(value: unknown): value is EntryChangeKind {
  return typeof value === 'string' && Object.hasOwn(reasons, value)
}

export function isFileChangeClassification(value: unknown): value is FileChangeClassification {
  return (
    record(value) &&
    isChangeKind(value.kind) &&
    reasons[value.kind].some((reason) => reason === value.reason)
  )
}

function invalidQuery(): SnapshotAccessError {
  return new SnapshotAccessError('INVALID_REQUEST', 'Invalid file change query.')
}

export function readComparisonFileQuery(value: unknown): ResolvedComparisonFileQuery {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'baselineScanId',
          'targetScanId',
          'offset',
          'limit',
          'sort',
          'relativeDirectory',
          'kinds'
        ].includes(key)
    ) ||
    !Object.hasOwn(value, 'baselineScanId') ||
    !Object.hasOwn(value, 'targetScanId') ||
    !isSnapshotId(value.baselineScanId) ||
    !isSnapshotId(value.targetScanId)
  )
    throw invalidQuery()

  const offset = Object.hasOwn(value, 'offset') ? value.offset : 0
  const limit = Object.hasOwn(value, 'limit') ? value.limit : DEFAULT_COMPARISON_PAGE_SIZE
  const sort = Object.hasOwn(value, 'sort') ? value.sort : 'path'
  if (
    !integer(offset) ||
    !integer(limit) ||
    limit < 1 ||
    limit > MAX_COMPARISON_PAGE_SIZE ||
    (sort !== 'path' && sort !== 'delta-asc' && sort !== 'delta-desc')
  )
    throw invalidQuery()

  const query = {
    baselineScanId: value.baselineScanId,
    targetScanId: value.targetScanId,
    offset,
    limit,
    sort
  } as const
  const relativeDirectory = Object.hasOwn(value, 'relativeDirectory') ? value.relativeDirectory : ''
  // POSIX key shape is common to both styles. The workspace also checks the source style.
  if (typeof relativeDirectory !== 'string' || !isComparisonPathKey(relativeDirectory, 'posix'))
    throw invalidQuery()
  const scope = relativeDirectory ? { relativeDirectory } : {}
  if (!Object.hasOwn(value, 'kinds')) return { ...query, ...scope }
  if (!Array.isArray(value.kinds)) throw invalidQuery()
  const kinds = new Set<EntryChangeKind>()
  for (const kind of value.kinds as unknown[]) {
    if (!isChangeKind(kind)) throw invalidQuery()
    kinds.add(kind)
  }
  return { ...query, ...scope, kinds: [...kinds] }
}

function isObservation(
  value: unknown,
  scanId: string,
  coverage: ComparisonCoverage
): value is ComparisonPathObservation {
  if (!record(value)) return false
  if (value.presence !== 'present')
    return value.presence === (coverage === 'complete' ? 'absent' : 'unknown')
  const entry = value.entry
  return (
    record(entry) &&
    entry.scanId === scanId &&
    isSnapshotId(entry.entryId) &&
    (entry.type === 'file' ||
      entry.type === 'directory' ||
      entry.type === 'symlink' ||
      entry.type === 'other' ||
      entry.type === 'unknown') &&
    (entry.sizeBytes === null || (entry.type === 'file' && integer(entry.sizeBytes))) &&
    nullableString(entry.modifiedAt)
  )
}

export function isComparisonFileResult(value: unknown): value is ComparisonFileResult {
  if (
    !record(value) ||
    !record(value.pair) ||
    !isCompatiblePair(value.compatibility) ||
    !integer(value.offset) ||
    !integer(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_COMPARISON_PAGE_SIZE ||
    !integer(value.totalCount) ||
    !Array.isArray(value.items)
  )
    return false
  const { pair, coverage, pathStyle } = value.compatibility
  if (
    value.pair.baselineScanId !== pair.baselineScanId ||
    value.pair.targetScanId !== pair.targetScanId
  )
    return false
  const count = Math.min(value.limit, Math.max(0, value.totalCount - value.offset))
  const end = value.offset + count
  if (value.items.length !== count || value.nextOffset !== (end < value.totalCount ? end : null))
    return false
  const paths = new Set<string>()
  for (const item of value.items as unknown[]) {
    if (
      !record(item) ||
      typeof item.relativePath !== 'string' ||
      !item.relativePath ||
      !isComparisonPathKey(item.relativePath, pathStyle) ||
      paths.has(item.relativePath) ||
      !isObservation(item.baseline, pair.baselineScanId, coverage.baseline) ||
      !isObservation(item.target, pair.targetScanId, coverage.target) ||
      (!(item.baseline.presence === 'present' && item.baseline.entry.type === 'file') &&
        !(item.target.presence === 'present' && item.target.entry.type === 'file')) ||
      !(item.deltaBytes === null || Number.isSafeInteger(item.deltaBytes)) ||
      !isFileChangeClassification({ kind: item.kind, reason: item.reason })
    )
      return false
    paths.add(item.relativePath)
  }
  return true
}
