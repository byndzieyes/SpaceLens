import type { InsightsSizeBucketId, InsightsSizeDistribution } from '../../../../shared/insights'
import { formatBytes } from '../../lib/storage'
import { InsightsAnalyticsSection } from './InsightsAnalyticsSection'
import { useInsightsRead, type InsightsSectionProps } from './useInsightsRead'

const buckets: Record<InsightsSizeBucketId, { label: string; range: string }> = {
  empty: { label: 'Empty', range: 'Exactly 0 B' },
  tiny: { label: 'Tiny', range: '1 B to less than 1 MiB' },
  small: { label: 'Small', range: '1 MiB to less than 10 MiB' },
  medium: { label: 'Medium', range: '10 MiB to less than 100 MiB' },
  large: { label: 'Large', range: '100 MiB to less than 1 GiB' },
  veryLarge: { label: 'Very Large', range: '1 GiB and above' }
}

const counts = new Intl.NumberFormat('en-US')
const readDistribution = (
  scanId: string
): ReturnType<Window['spaceLens']['getInsightsSizeDistribution']> =>
  window.spaceLens.getInsightsSizeDistribution({ scanId })

function SizeDistribution({ data }: { data: InsightsSizeDistribution }): React.JSX.Element {
  const maxCount = Math.max(0, ...data.buckets.map(({ fileCount }) => fileCount))

  return (
    <>
      <dl className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
        <div className="min-w-0">
          <dt className="text-xs text-text-secondary">Known-size files</dt>
          <dd className="font-semibold tabular-nums [overflow-wrap:anywhere]">
            {counts.format(data.knownSizeCount)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-text-secondary">Unknown-size files</dt>
          <dd className="font-semibold tabular-nums [overflow-wrap:anywhere]">
            {counts.format(data.totals.unknownSizeCount)}
          </dd>
        </div>
      </dl>
      {maxCount === 0 ? (
        <p className="text-sm text-text-secondary">
          {data.totals.fileCount === 0
            ? 'No files to chart in this scan.'
            : 'No file sizes are known for this scan.'}
        </p>
      ) : (
        <figure
          aria-label="File counts by logical size bucket"
          className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
        >
          <div
            aria-hidden="true"
            className="grid min-w-0 grid-cols-6 grid-rows-[minmax(7rem,1fr)_auto] gap-x-1 rounded-lg border border-separator bg-background/40 p-2 sm:grid-rows-[minmax(9rem,1fr)_auto] sm:gap-x-2 sm:p-4"
          >
            {data.buckets.map(({ id, fileCount }) => (
              <div key={id} className="row-span-2 grid min-w-0 grid-rows-subgrid text-center">
                <div className="flex items-end justify-center border-b border-border">
                  <div
                    data-size-bucket={id}
                    className="w-3/4 max-w-14 rounded-t-sm bg-accent"
                    style={{ height: `${(fileCount / maxCount) * 100}%` }}
                  />
                </div>
                <p className="mt-2 text-[0.6875rem] leading-tight text-text-secondary sm:text-xs [overflow-wrap:anywhere]">
                  {id === 'medium' ? (
                    <>
                      <span className="sm:hidden">Med.</span>
                      <span className="hidden sm:inline">Medium</span>
                    </>
                  ) : (
                    buckets[id].label
                  )}
                </p>
              </div>
            ))}
          </div>
          <ul
            aria-label="Size bucket details"
            role="list"
            className="min-w-0 divide-y divide-separator"
          >
            {data.buckets.map(({ id, fileCount, knownBytes }) => (
              <li
                key={id}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)] gap-3 px-1 py-2 [overflow-wrap:anywhere]"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{buckets[id].label}</p>
                  <p className="text-xs text-text-secondary">{buckets[id].range}</p>
                </div>
                <div className="min-w-0 text-right tabular-nums">
                  <p className="text-sm font-medium">
                    {counts.format(fileCount)} {fileCount === 1 ? 'file' : 'files'}
                  </p>
                  <p className="text-xs text-text-secondary">{formatBytes(knownBytes)} known</p>
                </div>
              </li>
            ))}
          </ul>
        </figure>
      )}
    </>
  )
}

export function InsightsSizeDistributionSection(props: InsightsSectionProps): React.JSX.Element {
  const { state, retry } = useInsightsRead(props, readDistribution, undefined)

  return (
    <InsightsAnalyticsSection
      title="File size distribution"
      description="File counts across six logical size ranges. Unknown sizes are counted separately."
      pageTitle={props.pageTitle}
      state={state}
      retry={retry}
      retryLabel="Retry distribution"
    >
      {state.status === 'ready' && <SizeDistribution data={state.data} />}
    </InsightsAnalyticsSection>
  )
}
