import { useId } from 'react'
import { Folder, History } from 'lucide-react'
import type { RecentScanSummary } from '../../../../shared/scan'
import { Card } from '../../components/ui/Card'
import { formatStorageSize } from '../../lib/storage'
import { formatScanDate, getRecentScans } from './recentScanUtils'

interface RecentScansProps {
  scans: readonly RecentScanSummary[]
}

const fileCountFormat = new Intl.NumberFormat('en-US')

export function RecentScans({ scans }: RecentScansProps): React.JSX.Element {
  const titleId = useId()
  const recentScans = getRecentScans(scans)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={titleId} className="text-base font-semibold">
          Recent Scans
        </h3>
        {scans.length > recentScans.length && (
          <p className="text-xs text-text-secondary">Showing latest {recentScans.length}</p>
        )}
      </div>
      <p className="text-xs text-text-secondary">
        Latest completed scan from this application session only. Results are cleared when the
        application closes. Sizes are known logical file bytes, not allocated disk space.
      </p>
      <Card aria-labelledby={titleId} className="min-w-0">
        {recentScans.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
            <div className="rounded-lg border border-accent/15 bg-accent/10 p-3">
              <History size={22} className="text-accent" aria-hidden="true" />
            </div>
            <h4 className="text-base font-medium">No scans yet</h4>
            <p className="max-w-sm text-sm text-text-secondary">
              Completed scans will appear here with a summary of their storage usage.
            </p>
          </div>
        ) : (
          <ol role="list" className="divide-y divide-separator">
            {recentScans.map((scan) => (
              <li
                key={scan.id}
                className="grid grid-cols-1 gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Folder size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium break-all">{scan.path}</p>
                    <p className="text-xs text-text-secondary">
                      Completed{' '}
                      <time dateTime={scan.completedAt}>{formatScanDate(scan.completedAt)}</time>
                    </p>
                    {(scan.errorCount ?? 0) > 0 && (
                      <p className="text-xs text-warning">
                        Completed with {fileCountFormat.format(scan.errorCount!)} filesystem errors.
                        Incomplete result; known totals may be lower than the full directory size.
                      </p>
                    )}
                  </div>
                </div>
                <dl className="flex flex-wrap gap-x-6 gap-y-2 pl-7.5 sm:justify-end sm:pl-0">
                  <div className="space-y-1 sm:text-right">
                    <dt className="text-xs text-text-secondary">Analyzed</dt>
                    <dd className="text-sm font-medium tabular-nums">
                      {formatStorageSize(scan.totalBytes)}
                      <span className="block text-xs text-text-secondary">
                        {fileCountFormat.format(scan.totalBytes)} bytes
                      </span>
                    </dd>
                  </div>
                  <div className="space-y-1 sm:text-right">
                    <dt className="text-xs text-text-secondary">Files</dt>
                    <dd className="text-sm font-medium tabular-nums">
                      {fileCountFormat.format(scan.fileCount)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}
