import { LoaderCircle } from 'lucide-react'
import type {
  AdoptedComparisonSelection,
  ComparisonCoverage,
  ComparisonErrorCode,
  ComparisonSide
} from '../../../../shared/comparison'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ComparisonSummaryView } from './ComparisonSummaryView'
import { sideLabels } from './draft'
import { useComparisonSummary } from './useComparisonSummary'

function coverageText(side: ComparisonSide, coverage: ComparisonCoverage): string {
  if (coverage === 'unknown') return `Coverage for the ${sideLabels[side]} is unknown.`
  return `${sideLabels[side]} has ${coverage === 'incomplete' ? 'partial' : 'complete'} coverage.`
}

function summaryError(
  code: ComparisonErrorCode,
  scanActive: boolean | undefined
): { message: string; retry: boolean } {
  switch (code) {
    case 'COMPARISON_SCAN_ACTIVE':
      return {
        message: scanActive
          ? 'Summary is temporarily unavailable while a scan is active.'
          : 'A scan paused summary loading. Retry when the scanner is idle.',
        retry: true
      }
    case 'COMPARISON_TIMEOUT':
      return {
        message:
          'The summary request timed out. Saved scan storage may need to recover before you retry.',
        retry: true
      }
    case 'UNAVAILABLE':
    case 'UNAUTHORIZED':
      return {
        message: 'Saved scan storage is unavailable. Reopen SpaceLens if this persists.',
        retry: true
      }
    case 'SNAPSHOT_EXPIRED':
    case 'SNAPSHOT_UNAVAILABLE':
      return {
        message:
          'This comparison selection is no longer available. Adopt the pair again to load a summary.',
        retry: false
      }
    case 'SIZE_OVERFLOW':
      return { message: 'The summary totals exceed the supported numeric range.', retry: false }
    default:
      return { message: 'The comparison summary could not be loaded.', retry: true }
  }
}

export function ComparisonDashboard({
  selection,
  scanActive
}: {
  selection: AdoptedComparisonSelection
  scanActive: boolean | undefined
}): React.JSX.Element {
  const { state, retry } = useComparisonSummary(selection, scanActive)
  const compatibility =
    state.status === 'ready' ? state.summary.compatibility : selection.compatibility
  const { coverage } = compatibility
  const complete = coverage.baseline === 'complete' && coverage.target === 'complete'
  const failure = state.status === 'error' ? summaryError(state.code, scanActive) : undefined

  return (
    <section aria-label="Comparison summary" className="min-w-0 space-y-3">
      <p className={`text-sm ${complete ? 'text-text-secondary' : 'text-warning'}`}>
        {complete
          ? 'Both snapshots have complete coverage.'
          : `${coverageText('baseline', coverage.baseline)} ${coverageText('target', coverage.target)}`}
      </p>
      {state.status === 'loading' && (
        <Card
          className="flex min-h-24 items-center gap-3 text-sm text-text-secondary"
          role="status"
        >
          <LoaderCircle
            aria-hidden="true"
            size={17}
            className="shrink-0 motion-safe:animate-spin"
          />
          Loading comparison summary…
        </Card>
      )}
      {failure && (
        <Card className="flex min-h-24 flex-wrap items-center justify-between gap-3">
          <p
            role="alert"
            className={`min-w-0 flex-1 text-sm ${state.status === 'error' && state.code === 'COMPARISON_SCAN_ACTIVE' ? 'text-warning' : 'text-error'}`}
          >
            {failure.message}
          </p>
          {failure.retry && (
            <Button variant="secondary" disabled={scanActive} onClick={retry}>
              Retry summary
            </Button>
          )}
        </Card>
      )}
      {state.status === 'ready' && <ComparisonSummaryView summary={state.summary} />}
    </section>
  )
}
