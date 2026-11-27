import {
  MAX_TREND_POINTS,
  type StorageTrends,
  type TrendPoint,
  type TrendSelection
} from '../../shared/trends'
import type { ScanStorageCoordinator } from './coordinator'
import type { TrendBatch } from './trendsContracts'

/** Separate admissions let queued scanner writes run between metadata batches. */
export async function readStorageTrends(
  storage: Pick<ScanStorageCoordinator, 'read'>,
  signal: AbortSignal,
  selection: TrendSelection
): Promise<StorageTrends | null> {
  const first = await storage.read(signal, (client) =>
    client.readTrendBatch({ selection, pointLimit: MAX_TREND_POINTS })
  )
  const { series, latestCompletedScanId, generation } = first
  const points: TrendPoint[] = [...first.points]
  let retainedCount = first.matchedCount
  let before = first.nextBefore

  while (series && before !== null) {
    const cursor = before
    const pointLimit = MAX_TREND_POINTS - points.length
    const batch: TrendBatch = await storage.read(signal, (client) =>
      client.readTrendBatch({ selection: { mode: 'series', series }, before: cursor, pointLimit })
    )
    if (batch.generation !== generation) return null
    if (
      batch.latestCompletedScanId !== latestCompletedScanId ||
      batch.series?.normalizedRoot !== series.normalizedRoot ||
      batch.series.pathStyle !== series.pathStyle ||
      batch.series.traversalPolicy !== series.traversalPolicy ||
      batch.points.length > pointLimit ||
      (batch.nextBefore !== null && batch.nextBefore >= cursor)
    )
      throw new Error('Storage returned a different trends batch.')
    points.push(...batch.points)
    retainedCount += batch.matchedCount
    before = batch.nextBefore
  }
  if (
    !Number.isSafeInteger(retainedCount) ||
    points.length !== Math.min(retainedCount, MAX_TREND_POINTS)
  )
    throw new Error('Invalid retained trend totals.')
  return { series, latestCompletedScanId, retainedCount, points: points.reverse() }
}
