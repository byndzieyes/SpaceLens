import { useRef, useState } from 'react'
import { ChartColumn, FolderTree } from 'lucide-react'
import type { StorageTrends } from '../../../../shared/trends'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { Pagination } from '../../components/ui/Pagination'
import { RowActionsMenu } from '../../components/ui/RowActionsMenu'
import { formatPreciseScanDate } from '../../lib/scanDisplay'
import { comparisonCounts as counts } from '../comparison/changeDisplay'
import { ComparisonBytes } from '../comparison/ComparisonBytes'
import { trendObservations } from './trendDisplay'

const pageSize = 20

export function TrendTimeline({
  data,
  onOpen
}: {
  data: StorageTrends
  onOpen: (view: SnapshotView, scanId: string) => void
}): React.JSX.Element {
  const [page, setPage] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const count = data.points.length
  const lastPage = Math.max(0, Math.ceil(count / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const offset = currentPage * pageSize
  const rows = trendObservations(data.points)
    .reverse()
    .slice(offset, offset + pageSize)
  const bytes = 'px-2 py-2.5 text-right whitespace-nowrap tabular-nums'
  return (
    <Card aria-labelledby="trend-timeline-title" className="min-w-0 space-y-3">
      <h4 ref={heading} id="trend-timeline-title" tabIndex={-1} className="text-base font-semibold">
        Scan timeline
      </h4>
      <Pagination
        label="Timeline pages"
        previousLabel="Previous timeline page"
        nextLabel="Next timeline page"
        range={`${counts.format(offset + 1)}–${counts.format(offset + rows.length)} of ${counts.format(count)} displayed snapshots`}
        previous={currentPage > 0 ? () => setPage(currentPage - 1) : null}
        next={currentPage < lastPage ? () => setPage(currentPage + 1) : null}
      />
      <div className="@container min-w-0 space-y-1.5">
        <p className="text-xs text-text-secondary @min-[40rem]:hidden">
          Scroll sideways to see all columns.
        </p>
        <div
          role="region"
          aria-label="Scan timeline table scroll area"
          tabIndex={0}
          className="overflow-x-auto rounded-lg border border-separator focus-visible:-outline-offset-2"
        >
          <table className="w-full min-w-[40rem] table-fixed text-left text-sm">
            <caption className="sr-only">Displayed snapshots, newest publication first</caption>
            <thead className="bg-surface-elevated text-xs text-text-secondary">
              <tr>
                <th scope="col" className="w-[30%] px-3 py-2.5 font-medium">
                  Completed
                </th>
                <th scope="col" className="w-[15%] px-2 py-2.5 text-right font-medium">
                  Known logical size
                </th>
                <th scope="col" className="w-[15%] px-2 py-2.5 text-right font-medium">
                  Observed change
                </th>
                <th scope="col" className="w-[9%] px-2 py-2.5 text-right font-medium">
                  Files
                </th>
                <th scope="col" className="w-[12%] px-2 py-2.5 text-right font-medium">
                  Directories
                </th>
                <th scope="col" className="px-2 py-2.5 font-medium">
                  Coverage
                </th>
                <th
                  scope="col"
                  className="sticky right-0 z-10 w-14 border-l border-separator bg-surface-elevated p-2 text-center font-medium"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-separator border-t border-separator align-top">
              {rows.map(({ point, previous, partial }, index) => {
                const ordinal = count - offset - index
                const date = formatPreciseScanDate(point.finishedAt)
                return (
                  <tr key={point.id} className="hover:bg-surface-hover/40">
                    <th scope="row" className="space-y-1 px-3 py-2.5 font-medium">
                      <time dateTime={point.finishedAt} className="block tabular-nums">
                        {date}
                      </time>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-text-secondary">
                        Scan {ordinal}
                        {point.id === data.latestCompletedScanId ? (
                          <Badge>Latest</Badge>
                        ) : ordinal === count ? (
                          <Badge>Latest in series</Badge>
                        ) : null}
                      </span>
                    </th>
                    <td className={bytes}>
                      <ComparisonBytes value={point.totalBytes} />
                    </td>
                    <td className={bytes}>
                      {previous ? (
                        <ComparisonBytes value={point.totalBytes - previous.totalBytes} signed />
                      ) : (
                        <span
                          title="No previous point in this window"
                          className="text-text-secondary"
                        >
                          Unavailable
                        </span>
                      )}
                      {previous && partial && (
                        <span className="block text-xs text-warning">Partial interval</span>
                      )}
                    </td>
                    <td className={bytes}>{counts.format(point.fileCount)}</td>
                    <td className={bytes}>{counts.format(point.directoryCount)}</td>
                    <td className="px-2 py-2.5 text-xs">
                      {point.incomplete ? (
                        <Badge variant="warning">Partial</Badge>
                      ) : (
                        <span className="text-text-secondary">Complete</span>
                      )}
                    </td>
                    <td className="sticky right-0 z-10 border-l border-separator bg-surface p-1.5 text-center">
                      <RowActionsMenu
                        label={`Actions for scan ${ordinal}, ${date}`}
                        menuLabel="Trend snapshot actions"
                        fallbackFocus={heading}
                        items={[
                          {
                            label: 'Open in Explorer',
                            icon: <FolderTree size={16} aria-hidden="true" />,
                            onSelect: () => onOpen('explorer', point.id)
                          },
                          {
                            label: 'Open in Insights',
                            icon: <ChartColumn size={16} aria-hidden="true" />,
                            onSelect: () => onOpen('insights', point.id)
                          }
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  )
}
