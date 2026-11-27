import type { TrendPoint } from '../../../../shared/trends'
import { comparisonCounts, comparisonSign } from '../comparison/changeDisplay'
import { formatBytes } from '../../lib/storage'

export const trendMetrics = {
  totalBytes: 'Logical size',
  fileCount: 'Files',
  directoryCount: 'Directories'
}
export type TrendMetric = keyof typeof trendMetrics
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function formatTrendMetric(metric: TrendMetric, value: number, axis = false): string {
  if (metric === 'totalBytes') return formatBytes(value)
  return (axis ? compact : comparisonCounts).format(value)
}

export function formatTrendChange(metric: TrendMetric, delta: number): string {
  return comparisonSign(delta) + formatTrendMetric(metric, Math.abs(delta))
}

export function trendObservations(points: readonly TrendPoint[]): {
  point: TrendPoint
  previous: TrendPoint | undefined
  partial: boolean
}[] {
  return points.map((point, index) => {
    const previous = points[index - 1]
    return { point, previous, partial: point.incomplete || previous?.incomplete === true }
  })
}
