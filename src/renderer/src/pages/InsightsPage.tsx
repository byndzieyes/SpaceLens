import { useRef } from 'react'
import { CircleAlert, Folder, FolderSearch, LoaderCircle } from 'lucide-react'
import type { InsightsSummary } from '../../../shared/insights'
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
import { formatScanDate } from '../features/overview/recentScanUtils'

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
  onOpenExplorer
}: {
  onOpenOverview: () => void
  onOpenExplorer?: (target: ExplorerTarget) => void
}): React.JSX.Element {
  const { state, retry, recheckPublication } = useInsights()
  const title = useRef<HTMLHeadingElement>(null)
  const analyticsScanId =
    state.status === 'ready'
      ? state.summary.scanId
      : state.status !== 'no-snapshot'
        ? state.analyticsScanId
        : undefined

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10">
      <header>
        <h2 ref={title} tabIndex={-1} className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Storage Insights
        </h2>
      </header>

      <Card aria-labelledby="insights-scan-title" className="min-w-0 space-y-4">
        <h3
          id="insights-scan-title"
          className="border-b border-separator pb-4 text-sm font-semibold"
        >
          Published scan
        </h3>
        {state.status === 'loading' && (
          <p role="status" className="flex items-center gap-2 py-2 text-sm text-text-secondary">
            <LoaderCircle
              size={16}
              className="shrink-0 text-accent motion-safe:animate-spin"
              aria-hidden="true"
            />
            {state.refreshing ? 'Loading the latest scan…' : 'Loading saved scan…'}
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
              {state.analyticsScanId
                ? 'SpaceLens couldn’t load the scan summary. Try again.'
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
      {analyticsScanId && (
        <div key={analyticsScanId} className="space-y-6">
          {state.status === 'ready' && <InsightsSummaryCards summary={state.summary.summary} />}
          <InsightsCategoriesSection
            scanId={analyticsScanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
          <InsightsSizeDistributionSection
            scanId={analyticsScanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
          <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
            <InsightsLargestFilesSection
              scanId={analyticsScanId}
              recheckPublication={recheckPublication}
              pageTitle={title}
              onOpenExplorer={onOpenExplorer}
            />
            <InsightsLargestDirectoriesSection
              scanId={analyticsScanId}
              recheckPublication={recheckPublication}
              pageTitle={title}
              onOpenExplorer={onOpenExplorer}
            />
          </div>
          <InsightsExtensionsSection
            scanId={analyticsScanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
          <InsightsObservationsSection
            scanId={analyticsScanId}
            recheckPublication={recheckPublication}
            pageTitle={title}
          />
        </div>
      )}
    </div>
  )
}
