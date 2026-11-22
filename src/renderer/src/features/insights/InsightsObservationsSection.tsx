import { Info, TriangleAlert } from 'lucide-react'
import type { InsightsObservation } from '../../../../shared/insights'
import { formatBytes } from '../../lib/storage'
import { InsightsAnalyticsSection } from './InsightsAnalyticsSection'
import { useInsightsRead, type InsightsSectionProps } from './useInsightsRead'

const count = new Intl.NumberFormat('en-US')
const readObservations = (
  scanId: string
): ReturnType<Window['spaceLens']['getInsightsObservations']> =>
  window.spaceLens.getInsightsObservations({ scanId })

function describeEvidence(observation: InsightsObservation): string {
  switch (observation.type) {
    case 'incompleteScan': {
      const { errorCount, unknownSizeCount } = observation.evidence
      const errors = errorCount === 1 ? 'filesystem error' : 'filesystem errors'
      const unknown = unknownSizeCount === 1 ? 'file with unknown size' : 'files with unknown sizes'
      return `${count.format(errorCount)} ${errors} · ${count.format(unknownSizeCount)} ${unknown}`
    }
    case 'smallFilesPrevalence':
      return `${count.format(observation.evidence.smallFileCount)} of ${count.format(observation.evidence.knownSizeCount)} files with known sizes`
    default:
      // The backend message identifies the group and its threshold.
      return `${formatBytes(observation.evidence.knownBytes)} of ${formatBytes(observation.evidence.totalKnownBytes)} in known logical bytes`
  }
}

export function InsightsObservationsSection(props: InsightsSectionProps): React.JSX.Element {
  const { state, retry } = useInsightsRead(props, readObservations, undefined)
  const observations = state.status === 'ready' ? state.data.observations : []

  return (
    <InsightsAnalyticsSection
      title="Storage observations"
      description="Patterns in the data this scan could observe."
      pageTitle={props.pageTitle}
      state={state}
      retry={retry}
      retryLabel="Retry observations"
    >
      {observations.length === 0 ? (
        <p className="text-sm text-text-secondary">
          No notable patterns met the observation rules.
        </p>
      ) : (
        <ul aria-label="Scan observations" role="list" className="divide-y divide-separator">
          {observations.map((observation) => {
            const warning = observation.severity === 'warning'
            const Icon = warning ? TriangleAlert : Info
            return (
              <li
                key={observation.id}
                data-observation-id={observation.id}
                data-observation-type={observation.type}
                className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0"
              >
                <Icon
                  size={17}
                  aria-hidden="true"
                  className={`mt-0.5 shrink-0 ${warning ? 'text-warning' : 'text-accent'}`}
                />
                <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
                  <p
                    className={`text-xs font-medium ${warning ? 'text-warning' : 'text-text-secondary'}`}
                  >
                    {warning ? 'Warning' : 'Information'}
                  </p>
                  <h4 className="text-sm font-semibold">{observation.title}</h4>
                  <p className="text-sm text-text-secondary">{observation.message}</p>
                  <p className="text-xs text-text-secondary tabular-nums">
                    {describeEvidence(observation)}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </InsightsAnalyticsSection>
  )
}
