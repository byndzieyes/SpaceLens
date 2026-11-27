import { useId, useRef, useState } from 'react'
import type { TrendPoint } from '../../../../shared/trends'
import { Badge } from '../../components/ui/Badge'
import { formatPreciseScanDate } from '../../lib/scanDisplay'
import { comparisonCounts } from '../comparison/changeDisplay'
import {
  formatTrendChange,
  formatTrendMetric,
  trendMetrics,
  trendObservations,
  type TrendMetric
} from './trendDisplay'

export function TrendChart({
  points,
  metric,
  latestCompletedScanId
}: {
  points: readonly TrendPoint[]
  metric: TrendMetric
  latestCompletedScanId: string | null
}): React.JSX.Element | null {
  const details = useId()
  const [selected, setSelected] = useState<string>()
  const markers = useRef(new Map<string, HTMLButtonElement>())
  if (!points.length) return null
  const observations = trendObservations(points)
  const values = points.map((point) => point[metric])
  const high = Math.max(...values)
  const minimum = Math.min(...values)
  const low =
    formatTrendMetric(metric, minimum, true) === formatTrendMetric(metric, high, true) ? 0 : minimum
  const y = (value: number): number =>
    high === low ? 50 : 8 + 84 * ((high - value) / (high - low))
  const positions = values.map((value, index) => ({
    x: points.length === 1 ? 50 : 4 + (92 * index) / (points.length - 1),
    y: y(value)
  }))
  const line = positions.map((position) => `${position.x},${position.y}`).join(' ')
  const area = `${line} ${positions.at(-1)!.x},92 ${positions[0].x},92`
  const ticks = [...new Set([high, low + Math.floor((high - low) / 2), low])]
  const index = points.findIndex((point) => point.id === selected)
  const activeIndex = index < 0 ? points.length - 1 : index
  const active = observations[activeIndex]
  const point = active.point
  const delta = active.previous ? point[metric] - active.previous[metric] : null
  const chooseNearest = (clientX: number, plot: HTMLElement): void => {
    const { left, width } = plot.getBoundingClientRect()
    if (!width) return
    const fraction = ((clientX - left) / width - 0.04) / 0.92
    setSelected(
      points[Math.max(0, Math.min(points.length - 1, Math.round(fraction * (points.length - 1))))]
        .id
    )
  }

  return (
    <figure
      aria-label={`${trendMetrics[metric]} by scan publication order`}
      className="min-w-0 space-y-3"
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 sm:gap-x-3">
        <div
          aria-hidden="true"
          className="relative col-start-1 row-start-1 min-w-14 text-right text-xs text-text-secondary tabular-nums"
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 w-max max-w-20 -translate-y-1/2"
              style={{ top: `${y(tick)}%` }}
            >
              {formatTrendMetric(metric, tick, true)}
            </span>
          ))}
        </div>
        <div
          className="relative col-start-2 row-start-1 h-44 min-w-0 sm:h-56"
          onPointerMove={(event) => {
            if (event.pointerType === 'mouse') chooseNearest(event.clientX, event.currentTarget)
          }}
          onClick={(event) => {
            if (event.detail) chooseNearest(event.clientX, event.currentTarget)
          }}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full"
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1="0"
                x2="100"
                y1={y(tick)}
                y2={y(tick)}
                vectorEffect="non-scaling-stroke"
                className="stroke-separator"
              />
            ))}
            {positions.length > 1 && (
              <>
                {high > low && <polygon points={area} className="fill-accent/10" />}
                <polyline
                  points={line}
                  fill="none"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                  className="stroke-accent-hover"
                />
              </>
            )}
          </svg>
          {points.map((point, index) => {
            const position = positions[index]
            const current = activeIndex === index
            return (
              <button
                key={point.id}
                ref={(element) => {
                  if (element) markers.current.set(point.id, element)
                  else markers.current.delete(point.id)
                }}
                type="button"
                tabIndex={current ? 0 : -1}
                aria-label={`Scan ${index + 1}, ${formatPreciseScanDate(point.finishedAt)}, ${formatTrendMetric(metric, point[metric])}, ${point.incomplete ? 'partial coverage' : 'complete coverage'}`}
                aria-pressed={current}
                aria-describedby={current ? details : undefined}
                onFocus={() => setSelected(point.id)}
                onClick={() => setSelected(point.id)}
                onKeyDown={(event) => {
                  const next = {
                    ArrowLeft: index - 1,
                    ArrowRight: index + 1,
                    Home: 0,
                    End: points.length - 1
                  }[event.key]
                  if (next === undefined) return
                  event.preventDefault()
                  markers.current
                    .get(points[Math.min(points.length - 1, Math.max(0, next))].id)
                    ?.focus({ preventScroll: true })
                }}
                className={`absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-sm ${current ? 'z-10' : ''}`}
                style={{ left: `${position.x}%`, top: `${position.y}%` }}
              >
                <span
                  aria-hidden="true"
                  className={`block border-2 bg-surface ${current ? 'size-3' : 'size-2.5'} ${point.incomplete ? 'rotate-45 rounded-none border-warning' : 'rounded-full border-accent-hover'}`}
                />
              </button>
            )
          })}
        </div>
        <div
          aria-hidden="true"
          className={`col-start-2 flex px-[4%] text-xs text-text-secondary tabular-nums ${points.length === 1 ? 'justify-center' : 'justify-between'}`}
        >
          <span>1</span>
          {points.length > 1 && <span>{comparisonCounts.format(points.length)}</span>}
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
        <span>Scan order · equally spaced points</span>
        {points.some((point) => point.incomplete) && <span>◇ Partial scan</span>}
      </figcaption>
      <div
        id={details}
        className="min-w-0 rounded-lg border border-separator bg-background/35 px-3 py-2 text-sm"
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium">Scan {activeIndex + 1}</span>
          <time dateTime={point.finishedAt} className="text-text-secondary">
            {formatPreciseScanDate(point.finishedAt)}
          </time>
          {point.id === latestCompletedScanId ? (
            <Badge>Latest</Badge>
          ) : activeIndex === points.length - 1 ? (
            <Badge>Latest in series</Badge>
          ) : null}
          {point.incomplete ? (
            <Badge variant="warning">Partial scan</Badge>
          ) : (
            <span className="text-xs text-text-secondary">Complete coverage</span>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-1 tabular-nums">
          <span
            className="font-medium"
            title={
              metric === 'totalBytes'
                ? `${comparisonCounts.format(point.totalBytes)} bytes`
                : undefined
            }
          >
            {formatTrendMetric(metric, point[metric])}
          </span>
          <span className="text-text-secondary">
            {delta === null
              ? 'No previous point in this window'
              : `${formatTrendChange(metric, delta)} from previous scan`}
          </span>
          {delta !== null && active.partial && (
            <span className="text-xs text-warning">Partial interval</span>
          )}
        </div>
      </div>
    </figure>
  )
}
