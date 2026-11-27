import { ChevronRight, Folder } from 'lucide-react'
import type { RefObject } from 'react'
import type { ScanHistoryItem, ScanHistoryPage } from '../../../../shared/history'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
import { Badge } from '../../components/ui/Badge'
import { formatPreciseScanDate, formatScanDate, formatScanDuration } from '../../lib/scanDisplay'
import { formatBytes } from '../../lib/storage'
import { SnapshotActions } from './SnapshotActions'

const counts = new Intl.NumberFormat('en-US')
const heading = 'px-2 py-3 font-medium'
const numericHeading = 'px-1 py-3 text-right font-medium'

function RootPath({ path }: { path: string }): React.JSX.Element {
  if (path.length <= 16)
    return <span className="block rounded-sm break-words whitespace-pre-wrap">{path}</span>

  return (
    <details className="group/path min-w-0">
      <summary
        title={path}
        className="flex cursor-pointer list-none items-center gap-1 rounded-sm hover:text-accent [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0 truncate whitespace-pre">{path}</span>
        <ChevronRight
          size={13}
          aria-hidden="true"
          className="shrink-0 text-text-secondary group-open/path:rotate-90"
        />
      </summary>
      <span className="mt-1 block text-xs font-normal break-all whitespace-pre-wrap text-text-secondary select-text">
        {path}
      </span>
    </details>
  )
}

function NumericCell({ value, exact }: { value: string; exact?: string }): React.JSX.Element {
  return (
    <td className="px-1 py-3 text-right tabular-nums">
      <span title={exact ?? value} className="block truncate">
        {value}
      </span>
    </td>
  )
}

export function HistoryTable({
  page,
  onOpen,
  onCompare,
  onDelete,
  fallbackFocus
}: {
  page: ScanHistoryPage
  onOpen: (view: SnapshotView, scan: ScanHistoryItem) => void
  onCompare: (scan: ScanHistoryItem) => void
  onDelete: (scan: ScanHistoryItem) => void
  fallbackFocus: RefObject<HTMLElement | null>
}): React.JSX.Element {
  const rows = page.items.map((scan) => ({ scan, completed: formatScanDate(scan.finishedAt) }))
  return (
    <div className="@container -mx-5 -mb-5 min-w-0 sm:-mx-6 sm:-mb-6">
      <p className="px-5 pb-2 text-xs text-text-secondary @min-[41rem]:hidden sm:px-6">
        Scroll sideways to see all columns.
      </p>
      <div
        role="region"
        aria-label="Saved snapshots table"
        tabIndex={0}
        className="overflow-x-auto rounded-b-xl border-t border-separator focus-visible:-outline-offset-2"
      >
        <table className="w-full min-w-[41rem] table-fixed text-left text-sm">
          <caption className="sr-only">Completed scan snapshots</caption>
          <thead className="bg-surface-elevated text-xs text-text-secondary">
            <tr>
              <th scope="col" className="w-[20%] py-3 pr-2 pl-5 font-medium sm:pl-6">
                Scan root
              </th>
              <th scope="col" className={`w-[18%] ${heading}`}>
                Completed
              </th>
              <th scope="col" className={`w-[13.5%] ${numericHeading}`}>
                Known logical size
              </th>
              <th scope="col" className={`w-[8%] ${numericHeading}`}>
                Files
              </th>
              <th scope="col" className={`w-[8%] ${numericHeading}`}>
                Folders
              </th>
              <th scope="col" className={`w-[10%] ${numericHeading}`}>
                Duration
              </th>
              <th scope="col" className={`w-[14%] ${heading}`}>
                Coverage
              </th>
              <th
                scope="col"
                className="sticky right-0 z-10 w-14 border-l border-separator bg-surface-elevated px-1 py-3 text-center font-medium"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-separator border-t border-separator">
            {rows.map(({ scan, completed }) => {
              const { fileCount, directoryCount, totalBytes, errorCount } = scan.summary
              const preciseDate = formatPreciseScanDate(scan.finishedAt)
              const needsPrecision = rows.some(
                (row) =>
                  row.scan.id !== scan.id &&
                  row.scan.rootPath === scan.rootPath &&
                  row.completed === completed
              )
              return (
                <tr key={scan.id} className="hover:bg-surface-hover/40">
                  <th scope="row" className="py-3 pr-2 pl-5 font-medium sm:pl-6">
                    <div className="flex min-w-0 items-start gap-2">
                      <Folder
                        size={15}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-accent"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <RootPath path={scan.rootPath} />
                        {scan.id === page.latestCompletedScanId && <Badge>Latest</Badge>}
                      </div>
                    </div>
                  </th>
                  <td className="px-2 py-3 text-text-secondary tabular-nums">
                    <time dateTime={scan.finishedAt} title={preciseDate}>
                      {needsPrecision ? preciseDate : completed}
                    </time>
                  </td>
                  <NumericCell
                    value={formatBytes(totalBytes)}
                    exact={`${counts.format(totalBytes)} bytes`}
                  />
                  <NumericCell value={counts.format(fileCount)} />
                  <NumericCell value={counts.format(directoryCount)} />
                  <NumericCell value={formatScanDuration(scan.durationMs)} />
                  <td className="py-3 pr-1 pl-2">
                    {scan.incomplete ? (
                      <div className="space-y-1">
                        <Badge
                          variant="warning"
                          className="whitespace-nowrap"
                          title="Known totals may be lower than the full directory size."
                        >
                          Partial scan
                        </Badge>
                        {errorCount > 0 && (
                          <span className="block text-xs text-text-secondary tabular-nums">
                            {counts.format(errorCount)} {errorCount === 1 ? 'error' : 'errors'}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-text-secondary">Complete</span>
                    )}
                  </td>
                  <td className="sticky right-0 z-10 border-l border-separator bg-surface p-2 text-center">
                    <SnapshotActions
                      scan={scan}
                      onOpen={onOpen}
                      onCompare={onCompare}
                      onDelete={onDelete}
                      fallbackFocus={fallbackFocus}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
