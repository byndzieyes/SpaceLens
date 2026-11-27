import { useRef } from 'react'
import { CircleAlert, Folder, FolderSearch, LoaderCircle } from 'lucide-react'
import type { InsightsSummary } from '../../../shared/insights'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { InsightsCategoriesSection } from '../features/insights/InsightsCategoriesSection'
import { InsightsExtensionsSection } from '../features/insights/InsightsExtensionsSection'
import { InsightsObservationsSection } from '../features/insights/InsightsObservationsSection'
import type { ExplorerTarget } from '../navigation'
import {
  InsightsLargestDirectoriesSection,
  InsightsLargestFilesSection
} from '../features/insights/InsightsLargestSections'
import { InsightsSizeDistributionSection } from '../features/insights/InsightsSizeDistributionSection'
import { InsightsSummaryCards } from '../features/insights/InsightsSummaryCards'
import { useInsights } from '../features/insights/useInsights'
import { formatScanDate } from '../lib/scanDisplay'
import type { ViewSnapshotOptions } from '../features/snapshots/selection'

const errorMessages = {
  expired: 'The latest scan changed. Reload to see the current results.',
  unavailable: 'This saved scan is no longer available. Reload to check for a completed scan.',
  read: 'SpaceLens couldn’t load the saved scan. Try again.'
}

function PublishedScan({ scan }: { scan: InsightsSummary }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <dl className="grid min-w-0 gap-x-8 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-1">
          <dt className="text-xs text-text-secondary">Root folder</dt>
          <dd className="flex min-w-0 items-start gap-2 text-sm font-medium">
            <Folder size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{scan.rootPath}</span>
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-text-secondary">Completed</dt>
          <dd className="text-sm font-medium">
            <time dateTime={scan.completedAt}>{formatScanDate(scan.completedAt)}</time>
          </dd>
        </div>
      </dl>
      {scan.incomplete && (
        <div className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 p-3 text-sm">
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-text-secondary">
            <strong className="font-medium text-warning">Some items couldn’t be scanned.</strong>{' '}
            Insights reflects the items SpaceLens was able to scan.
          </p>
        </div>
      )}
      {scan.summary.fileCount === 0 && (
        <p className="text-sm text-text-secondary">No files were found in this scan.</p>
      )}
    </div>
  )
}

export function InsightsPage({
  onOpenOverview,
  onOpenExplorer,
  snapshots,
  onFollowLatest
}: {
  onOpenOverview: () => void
  onOpenExplorer?: (target: ExplorerTarget) => void
  snapshots?: ViewSnapshotOptions
  onFollowLatest?: () => void
}): React.JSX.Element {
  const { state, historical, retry, recheckPublication } = useInsights(snapshots)
  const explicit = snapshots?.selection.mode === 'explicit'
  const title = useRef<HTMLHeadingElement>(null)
  const analytics = state.status === 'no-snapshot' ? undefined : state.analytics
  const analyticsScanId = analytics?.scanId
  const openRankedEntry =
    onOpenExplorer &&
    ((entry: ExplorerTarget): void => {
      if (entry.scanId === analyticsScanId) onOpenExplorer(entry)
    })

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10">
      <header className="space-y-2">
        <h2 ref={title} tabIndex={-1} className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Storage Insights
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{explicit ? 'Explicit snapshot' : 'Following Latest'}</Badge>
          {analyticsScanId && historical && <Badge>Historical snapshot</Badge>}
          {explicit && onFollowLatest && (
            <Button
              variant="secondary"
              onClick={(event) => {
                event.currentTarget.closest('main')?.focus({ preventScroll: true })
                onFollowLatest()
              }}
            >
              Follow Latest
            </Button>
          )}
        </div>
      </header>

      <Card aria-labelledby="insights-scan-title" className="min-w-0 space-y-4">
        <h3
          id="insights-scan-title"
          className="border-b border-separator pb-4 text-sm font-semibold"
        >
          {explicit ? 'Selected snapshot' : 'Published scan'}
        </h3>
        {state.status === 'loading' && (
          <p role="status" className="flex items-center gap-2 py-2 text-sm text-text-secondary">
            <LoaderCircle
              size={16}
              className="shrink-0 text-accent motion-safe:animate-spin"
              aria-hidden="true"
            />
            {state.refreshing && !explicit ? 'Loading the latest scan…' : 'Loading saved scan…'}
          </p>
        )}
        {state.status === 'no-snapshot' && (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
            <div className="rounded-lg border border-accent/15 bg-accent/10 p-3">
              <FolderSearch size={22} className="text-accent" aria-hidden="true" />
            </div>
            <h4 className="text-base font-medium">No completed scan</h4>
            <p className="max-w-sm text-sm text-text-secondary">
              Scan a folder from Overview to see its storage insights here.
            </p>
            <Button
              variant="secondary"
              onClick={(event) => {
                event.currentTarget.closest('main')?.focus()
                onOpenOverview()
              }}
            >
              Go to Overview
            </Button>
          </div>
        )}
        {state.status === 'error' && (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-error">
              {analyticsScanId
                ? 'SpaceLens couldn’t load the scan summary. Try again.'
                : explicit && state.reason !== 'read'
                  ? 'This saved snapshot is unavailable. Reload to retry this selection.'
                  : errorMessages[state.reason]}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                title.current?.focus()
                retry()
              }}
            >
              {state.reason === 'read' ? 'Try again' : 'Reload scan'}
            </Button>
          </div>
        )}
        {state.status === 'ready' && <PublishedScan scan={state.summary} />}
      </Card>
      {analytics && (
        <div key={analytics.generation} className="space-y-6">
          {state.status === 'ready' && <InsightsSummaryCards summary={state.summary.summary} />}
          <InsightsCategoriesSection
            scanId={analytics.scanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
          <InsightsSizeDistributionSection
            scanId={analytics.scanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
          <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
            <InsightsLargestFilesSection
              scanId={analytics.scanId}
              recheckPublication={recheckPublication}
              pageTitle={title}
              onOpenExplorer={openRankedEntry}
            />
            <InsightsLargestDirectoriesSection
              scanId={analytics.scanId}
              recheckPublication={recheckPublication}
              pageTitle={title}
              onOpenExplorer={openRankedEntry}
            />
          </div>
          <InsightsExtensionsSection
            scanId={analytics.scanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
          <InsightsObservationsSection
            scanId={analytics.scanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
        </div>
      )}
    </div>
  )
}
