import { formatBytes } from '../../lib/storage'
import { InsightsAnalyticsSection } from './InsightsAnalyticsSection'
import { InsightsPagination } from './InsightsPagination'
import { categoryLabels } from './insightsDisplay'
import { useInsightsRead, type InsightsSectionProps } from './useInsightsRead'

const PAGE_SIZE = 20
const counts = new Intl.NumberFormat('en-US')

const readExtensions = (
  scanId: string,
  offset: number
): ReturnType<Window['spaceLens']['listInsightsExtensions']> =>
  window.spaceLens.listInsightsExtensions({ scanId, offset, limit: PAGE_SIZE })

export function InsightsExtensionsSection(props: InsightsSectionProps): React.JSX.Element {
  const { state, load, retry } = useInsightsRead(props, readExtensions, 0)
  const page = state.status === 'ready' ? state.data : null
  const offset = state.status === 'ready' ? state.query : 0
  const nextOffset = page?.nextOffset ?? null
  const showRange = page && page.extensions.length > 0

  return (
    <InsightsAnalyticsSection
      title="File extensions"
      description="Grouped by filename extension. File counts include files whose size is unknown."
      pageTitle={props.pageTitle}
      state={state}
      retry={retry}
      retryLabel="Retry extensions"
      controls={
        <InsightsPagination
          label="Extensions pagination"
          previousLabel="Previous extension page"
          nextLabel="Next extension page"
          range={
            showRange
              ? `${counts.format(offset + 1)}–${counts.format(offset + page.extensions.length)} of ${counts.format(page.totalCount)} extensions`
              : page && '0 extensions'
          }
          previous={offset > 0 ? () => load(Math.max(0, offset - PAGE_SIZE)) : null}
          next={nextOffset === null ? null : () => load(nextOffset)}
        />
      }
    >
      {showRange ? (
        <div className="@container min-w-0">
          <p className="mb-2 text-xs text-text-secondary @min-[31rem]:hidden">
            Scroll sideways to see all columns.
          </p>
          <div
            role="region"
            tabIndex={0}
            aria-label="Extension groups table"
            className="min-w-0 overflow-x-auto focus-visible:-outline-offset-2"
          >
            <table
              aria-label="File extension groups"
              className="w-full min-w-[31rem] table-fixed text-sm tabular-nums [overflow-wrap:anywhere]"
            >
              <thead className="border-b border-separator text-xs text-text-secondary">
                <tr>
                  <th scope="col" className="w-[23%] px-2 py-2 text-left font-medium">
                    Extension
                  </th>
                  <th scope="col" className="w-[20%] px-2 py-2 text-left font-medium">
                    Category
                  </th>
                  <th scope="col" className="w-[15%] px-2 py-2 text-right font-medium">
                    Files
                  </th>
                  <th scope="col" className="w-[22%] px-2 py-2 text-right font-medium">
                    Known logical size
                  </th>
                  <th scope="col" className="w-[20%] px-2 py-2 text-right font-medium">
                    Unknown-size files
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {page.extensions.map(
                  ({ extension, category, fileCount, knownBytes, unknownSizeCount }) => (
                    <tr key={extension === null ? 'no-extension' : `.${extension}`}>
                      <th scope="row" className="px-2 py-2 text-left font-medium">
                        {extension === null ? (
                          'No extension'
                        ) : (
                          <bdi className="font-mono whitespace-pre-wrap">.{extension}</bdi>
                        )}
                      </th>
                      <td className="px-2 py-2 text-text-secondary">{categoryLabels[category]}</td>
                      <td className="px-2 py-2 text-right">{counts.format(fileCount)}</td>
                      <td className="px-2 py-2 text-right">{formatBytes(knownBytes)}</td>
                      <td className="px-2 py-2 text-right text-text-secondary">
                        {counts.format(unknownSizeCount)}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">No extension groups in this scan.</p>
      )}
    </InsightsAnalyticsSection>
  )
}
