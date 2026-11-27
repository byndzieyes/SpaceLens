import {
  MAX_TREND_POINTS,
  type TrendPoint,
  type TrendSelection,
  type TrendSeries
} from '../../shared/trends'
import { comparisonSeries } from '../comparison/compatibility'
import { integer, isSnapshotId, record } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'

export const TREND_BATCH_SIZE = 128

export interface TrendBatchRequest {
  readonly selection: TrendSelection
  readonly before?: bigint
  readonly pointLimit: number
}

export interface TrendBatch {
  readonly series: TrendSeries | null
  readonly latestCompletedScanId: string | null
  readonly generation: bigint
  readonly nextBefore: bigint | null
  readonly matchedCount: number
  /** Descending publication order within this batch. */
  readonly points: readonly TrendPoint[]
}

function isSeries(value: unknown): value is TrendSeries {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.normalizedRoot !== 'string' ||
    value.normalizedRoot.length > 32767 ||
    (value.pathStyle !== 'posix' && value.pathStyle !== 'win32') ||
    typeof value.traversalPolicy !== 'string'
  )
    return false
  const { normalizedRoot, pathStyle, traversalPolicy } = value
  return (
    comparisonSeries(normalizedRoot, { pathStyle, traversalPolicy })?.normalizedRoot ===
    normalizedRoot
  )
}

export function readTrendSelection(value: unknown): TrendSelection {
  if (record(value)) {
    const length = Object.keys(value).length
    if (value.mode === 'latest' && length === 1) return { mode: 'latest' }
    if (value.mode === 'snapshot' && length === 2 && isSnapshotId(value.scanId))
      return { mode: 'snapshot', scanId: value.scanId }
    if (value.mode === 'series' && length === 2 && isSeries(value.series))
      return { mode: 'series', series: value.series }
  }
  throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid storage trends selection.')
}

function isCursor(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value <= 0x7fff_ffff_ffff_ffffn
}

export function readTrendBatchRequest(value: unknown): TrendBatchRequest {
  if (
    !record(value) ||
    !integer(value.pointLimit) ||
    value.pointLimit > MAX_TREND_POINTS ||
    Object.keys(value).some((key) => !['selection', 'before', 'pointLimit'].includes(key))
  )
    throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid storage trends batch.')
  const selection = readTrendSelection(value.selection)
  if (!Object.hasOwn(value, 'before')) return { selection, pointLimit: value.pointLimit }
  if (selection.mode === 'series' && isCursor(value.before))
    return { selection, pointLimit: value.pointLimit, before: value.before }
  throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid storage trends cursor.')
}

function isPoint(value: unknown): value is TrendPoint {
  return (
    record(value) &&
    Object.keys(value).length === 6 &&
    isSnapshotId(value.id) &&
    typeof value.finishedAt === 'string' &&
    Number.isFinite(Date.parse(value.finishedAt)) &&
    integer(value.totalBytes) &&
    integer(value.fileCount) &&
    integer(value.directoryCount) &&
    value.directoryCount > 0 &&
    typeof value.incomplete === 'boolean'
  )
}

export function isTrendBatch(value: unknown): value is TrendBatch {
  if (
    !record(value) ||
    Object.keys(value).length !== 6 ||
    (value.series !== null && !isSeries(value.series)) ||
    (value.latestCompletedScanId !== null && !isSnapshotId(value.latestCompletedScanId)) ||
    typeof value.generation !== 'bigint' ||
    value.generation < 0n ||
    (value.nextBefore !== null && !isCursor(value.nextBefore)) ||
    !integer(value.matchedCount) ||
    value.matchedCount > TREND_BATCH_SIZE ||
    !Array.isArray(value.points) ||
    value.points.length > Math.min(MAX_TREND_POINTS, value.matchedCount)
  )
    return false
  if (value.series === null && value.latestCompletedScanId !== null) return false
  if (
    value.latestCompletedScanId === null &&
    (value.nextBefore !== null || value.matchedCount !== 0)
  )
    return false
  return (
    Array.from(value.points).every(isPoint) &&
    new Set(value.points.map((point: TrendPoint) => point.id)).size === value.points.length
  )
}
