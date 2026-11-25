import { useId } from 'react'
import { Folder, History } from 'lucide-react'
import type { ScanHistoryItem } from '../../../../shared/history'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatStorageSize } from '../../lib/storage'
import { formatScanDate, formatScanDuration } from './recentScanUtils'
import type { RecentScansState } from './useRecentScans'

interface RecentScansProps {
  state: RecentScansState
  onRetry: () => void
  onOpenSnapshot?: (view: SnapshotView, scanId: string) => void
}

const counts = new Intl.NumberFormat('en-US')
const destinations = [
  { view: 'explorer', label: 'Open in Explorer' },
  { view: 'insights', label: 'Open in Insights' }
] as const

function RecentScanRow({
  scan,
  latest,
  onOpenSnapshot
}: {
  scan: ScanHistoryItem
  latest: boolean
  onOpenSnapshot?: RecentScansProps['onOpenSnapshot']
}): React.JSX.Element {
  const { totalBytes, fileCount, directoryCount, errorCount } = scan.summary
  const completed = formatScanDate(scan.finishedAt)
  return (
    <li className="flex min-w-0 items-start gap-3 py-4 first:pt-0 last:pb-0">
      <Folder size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">
          {scan.rootPath}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-xs text-text-secondary">
            Completed <time dateTime={scan.finishedAt}>{completed}</time>
          </p>
          {latest && <Badge>Latest</Badge>}
        </div>
        {scan.incomplete && (
          <p className="text-xs text-warning">
            {errorCount > 0 && (
              <>
                Completed with {counts.format(errorCount)} filesystem{' '}
                {errorCount === 1 ? 'error' : 'errors'}.{' '}
              </>
            )}
            Incomplete result. Known totals may be lower than the full directory size.
          </p>
        )}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <dl className="flex min-w-0 flex-wrap gap-x-5 gap-y-2 [overflow-wrap:anywhere]">
            <div>
              <dt className="text-xs text-text-secondary">Known logical size</dt>
              <dd className="text-sm font-medium tabular-nums">
                {formatStorageSize(totalBytes)}
                <span className="block text-xs text-text-secondary">
                  {counts.format(totalBytes)} bytes
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Files</dt>
              <dd className="text-sm font-medium tabular-nums">{counts.format(fileCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Directories</dt>
              <dd className="text-sm font-medium tabular-nums">{counts.format(directoryCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Duration</dt>
              <dd className="text-sm font-medium tabular-nums">
                {formatScanDuration(scan.durationMs)}
              </dd>
            </div>
          </dl>
          {onOpenSnapshot && (
            <div className="flex min-w-0 flex-wrap gap-2">
              {destinations.map(({ view, label }) => (
                <Button
                  key={view}
                  variant="secondary"
                  className="h-auto max-w-full px-3 text-left"
                  aria-label={`${label} for ${scan.rootPath} completed ${completed}`}
                  onClick={(event) => {
                    event.currentTarget.closest('main')?.focus({ preventScroll: true })
                    onOpenSnapshot(view, scan.id)
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

export function RecentScans({
  state,
  onRetry,
  onOpenSnapshot
}: RecentScansProps): React.JSX.Element {
  const titleId = useId()
  const { page } = state
  const hasItems = !!page?.items.length
  return (
    <div className="space-y-4">
      <h3 id={titleId} className="text-base font-semibold">
        Recent Scans
      </h3>
      <Card aria-labelledby={titleId} className="min-w-0 space-y-4">
        {state.status === 'loading' && (
          <p role="status" className="text-sm text-text-secondary">
            {page ? 'Refreshing recent scans…' : 'Loading saved scans…'}
          </p>
        )}
        {state.status === 'error' && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="min-w-0 text-sm text-error">
              {state.message}
              {hasItems && ' Showing the last loaded list.'}
            </p>
            <Button variant="secondary" onClick={onRetry}>
              Retry recent scans
            </Button>
          </div>
        )}
        {page && hasItems ? (
          <ol role="list" className="divide-y divide-separator">
            {page.items.map((scan) => (
              <RecentScanRow
                key={scan.id}
                scan={scan}
                latest={scan.isLatest && scan.id === page.latestCompletedScanId}
                onOpenSnapshot={onOpenSnapshot}
              />
            ))}
          </ol>
        ) : state.status === 'ready' ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
            <div className="rounded-lg border border-accent/15 bg-accent/10 p-3">
              <History size={22} className="text-accent" aria-hidden="true" />
            </div>
            <h4 className="text-base font-medium">No scans yet</h4>
            <p className="max-w-sm text-sm text-text-secondary">
              Completed scans will appear here with a summary of their storage usage.
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  )
}
