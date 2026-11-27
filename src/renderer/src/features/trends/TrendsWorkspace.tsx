import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { StorageTrends } from '../../../../shared/trends'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
import type { ScanHistoryErrorCode } from '../../../../shared/history'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatChangePercentage, formatPreciseScanDate } from '../../lib/scanDisplay'
import { ComparisonBytes } from '../comparison/ComparisonBytes'
import { comparisonCounts as counts } from '../comparison/changeDisplay'
import { SnapshotPicker } from '../comparison/SnapshotPicker'
import { useComparisonHistory } from '../comparison/draft'
import type { HistoryFeedback } from '../history/HistorySettings'
import { TrendChart } from './TrendChart'
import { TrendTimeline } from './TrendTimeline'
import { formatTrendChange, trendMetrics, type TrendMetric } from './trendDisplay'
import { useStorageTrends } from './useStorageTrends'

const recentQuery = { offset: 0, sort: 'newest' } as const
const metrics = Object.keys(trendMetrics) as TrendMetric[]

function failureMessage(code: ScanHistoryErrorCode | 'HISTORY_CHANGED'): string {
  switch (code) {
    case 'SNAPSHOT_EXPIRED':
      return 'That snapshot is no longer retained. Choose another snapshot.'
    case 'SNAPSHOT_UNAVAILABLE':
      return 'That snapshot has no available compatible trend series. Choose another snapshot.'
    case 'HISTORY_CHANGED':
      return 'Saved history changed while trends were loading. Retry to read the current series.'
    case 'UNAVAILABLE':
    case 'UNAUTHORIZED':
      return 'Saved scan storage is unavailable.'
    default:
      return 'Storage trends could not be loaded.'
  }
}

function TrendSummary({ data }: { data: StorageTrends }): React.JSX.Element {
  const { points, retainedCount } = data
  const first = points[0]
  const last = points.at(-1)!
  const delta = points.length > 1 ? last.totalBytes - first.totalBytes : null
  const percent =
    delta === null || first.totalBytes === 0
      ? undefined
      : formatChangePercentage(delta, first.totalBytes)
  return (
    <div className="space-y-2">
      <dl className="grid min-w-0 grid-cols-2 gap-2 @min-[36rem]:grid-cols-3">
        <div className="min-w-0 rounded-lg border border-separator bg-background/25 p-3">
          <dt className="text-xs text-text-secondary">Latest known logical size in this series</dt>
          <dd className="font-semibold tabular-nums">
            <ComparisonBytes value={last.totalBytes} />
          </dd>
        </div>
        <div className="min-w-0 rounded-lg border border-separator bg-background/25 p-3">
          <dt className="text-xs text-text-secondary">Retained snapshots in this series</dt>
          <dd className="font-semibold tabular-nums">{counts.format(retainedCount)}</dd>
        </div>
        <div className="col-span-2 min-w-0 rounded-lg border border-separator bg-background/25 p-3 @min-[36rem]:col-span-1">
          <dt className="text-xs text-text-secondary">Observed size change in this window</dt>
          <dd className="flex flex-wrap items-baseline gap-x-2 font-semibold tabular-nums">
            <ComparisonBytes value={delta} signed />
            {percent && (
              <span className="text-xs font-normal text-text-secondary [overflow-wrap:anywhere]">
                {percent}
              </span>
            )}
          </dd>
          {delta !== null && (
            <dd className="text-xs text-text-secondary tabular-nums">
              {formatTrendChange('fileCount', last.fileCount - first.fileCount)} files ·{' '}
              {formatTrendChange('directoryCount', last.directoryCount - first.directoryCount)}{' '}
              directories
            </dd>
          )}
        </div>
      </dl>
      <p className="text-sm text-text-secondary" role="status">
        {retainedCount > points.length
          ? `Showing the latest ${counts.format(points.length)} of ${counts.format(retainedCount)} retained snapshots.`
          : points.length > 1
            ? `Showing all ${counts.format(points.length)} retained snapshots in this series.`
            : 'One retained snapshot. A trend needs at least two scans.'}
      </p>
      {points.length > 1 && (
        <p className="text-xs text-text-secondary">
          First displayed publication{' '}
          <time dateTime={first.finishedAt}>{formatPreciseScanDate(first.finishedAt)}</time>
          {' · '}Last displayed publication{' '}
          <time dateTime={last.finishedAt}>{formatPreciseScanDate(last.finishedAt)}</time>
        </p>
      )}
    </div>
  )
}

export function TrendsWorkspace({
  active,
  historyRevision,
  opening,
  feedback,
  onOpen,
  onOpenPicker
}: {
  active: boolean
  historyRevision: number
  opening?: SnapshotView
  feedback?: HistoryFeedback
  onOpen: (view: SnapshotView, scanId: string) => void
  onOpenPicker: () => void
}): React.JSX.Element {
  const [metric, setMetric] = useState<TrendMetric>('totalBytes')
  const [picker, setPicker] = useState(false)
  const { state, anchor, select, retry } = useStorageTrends(active, historyRevision)
  const recent = useComparisonHistory(active && picker ? recentQuery : undefined, historyRevision)
  const data = state.data
  const root = data?.series?.normalizedRoot ?? anchor
  const hasPoints = !!data?.points.length
  return (
    <div className="@container min-w-0 space-y-4">
      <Card aria-labelledby="storage-trends-title" className="min-w-0 space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <h3 id="storage-trends-title" className="text-lg font-semibold">
              Storage Trends
            </h3>
            <div className="mt-1 text-sm text-text-secondary">
              {root ? (
                <p title={root} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {root}
                </p>
              ) : (
                'No scan root selected'
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            aria-haspopup="dialog"
            onClick={() => {
              onOpenPicker()
              setPicker(true)
            }}
          >
            Choose scan root <ChevronDown size={16} aria-hidden="true" />
          </Button>
        </header>
        {state.status === 'loading' && (
          <p role="status" className="text-sm text-text-secondary">
            {data ? 'Refreshing retained snapshots…' : 'Loading storage trends…'}
          </p>
        )}
        {state.status === 'error' && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-error">
              {failureMessage(state.code)}
            </p>
            {state.code !== 'SNAPSHOT_EXPIRED' && state.code !== 'SNAPSHOT_UNAVAILABLE' && (
              <Button variant="secondary" onClick={retry}>
                Retry trends
              </Button>
            )}
            {hasPoints && (
              <p className="basis-full text-xs text-text-secondary">
                Showing the last loaded observations.
              </p>
            )}
          </div>
        )}
        {state.status === 'ready' && !hasPoints && (
          <p className="text-sm text-text-secondary">
            {data?.series
              ? 'No retained snapshots remain in this series.'
              : 'No saved snapshots yet. Complete a scan to start a trend.'}
          </p>
        )}
        {opening && (
          <p role="status" className="text-sm text-text-secondary">
            Opening saved snapshot in {opening === 'explorer' ? 'Explorer' : 'Insights'}…
          </p>
        )}
        {feedback && (
          <p
            role={feedback.status === 'error' ? 'alert' : 'status'}
            className={feedback.status === 'error' ? 'text-sm text-error' : 'text-sm text-success'}
          >
            {feedback.message}
          </p>
        )}
        {data && hasPoints && (
          <>
            <TrendSummary data={data} />
            <div className="space-y-3 border-t border-separator pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-base font-semibold">Historical trend</h4>
                <div
                  role="group"
                  aria-label="Trend metric"
                  className="flex flex-wrap gap-1 rounded-lg border border-border bg-background/40 p-1"
                >
                  {metrics.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={metric === option}
                      onClick={() => setMetric(option)}
                      className="rounded-md px-2.5 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-hover aria-pressed:bg-surface-elevated aria-pressed:text-text-primary"
                    >
                      {trendMetrics[option]}
                    </button>
                  ))}
                </div>
              </div>
              <TrendChart
                key={data.series?.normalizedRoot}
                points={data.points}
                metric={metric}
                latestCompletedScanId={data.latestCompletedScanId}
              />
              {data.points.some((point) => point.incomplete) && (
                <p className="text-sm text-warning">
                  Partial scans can omit entries. Observed size and count changes may reflect gaps
                  in coverage.
                </p>
              )}
            </div>
          </>
        )}
      </Card>
      {data && hasPoints && (
        <TrendTimeline key={data.series?.normalizedRoot} data={data} onOpen={onOpen} />
      )}
      {active && picker && (
        <SnapshotPicker
          title="Choose a scan root"
          recent={recent}
          historyRevision={historyRevision}
          selectedId={data?.points.at(-1)?.id}
          onSelect={(scan) => {
            select(scan.id, scan.rootPath)
            setPicker(false)
          }}
          onDismiss={() => setPicker(false)}
        />
      )}
    </div>
  )
}
