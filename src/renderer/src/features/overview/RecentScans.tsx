import { useId } from 'react'
import { Folder, History } from 'lucide-react'
import type { ScanStateSnapshot } from '../../../../shared/ipc'
import type { RecentScanSummary } from '../../../../shared/scan'
import { Card } from '../../components/ui/Card'
import { formatStorageSize } from '../../lib/storage'
import { formatScanDate } from './recentScanUtils'

interface RecentScansProps {
  scan: RecentScanSummary | null
  status: NonNullable<ScanStateSnapshot['publicationStatus']>
}

const counts = new Intl.NumberFormat('en-US')

export function RecentScans({ scan, status }: RecentScansProps): React.JSX.Element {
  const titleId = useId()

  return (
    <div className="space-y-4">
      <h3 id={titleId} className="text-base font-semibold">
        Recent Scans
      </h3>
      <p className="text-xs text-text-secondary">
        SpaceLens keeps the latest published scan. Sizes show known logical file bytes.
      </p>
      <Card aria-labelledby={titleId} className="min-w-0">
        {status === 'loading' ? (
          <p role="status" className="py-6 text-sm text-text-secondary">
            Loading saved scan…
          </p>
        ) : status === 'unavailable' ? (
          <p role="alert" className="py-6 text-sm text-error">
            Saved scan storage is unavailable. Restart SpaceLens to retry.
          </p>
        ) : scan ? (
          <ol role="list" className="divide-y divide-separator">
            <li
              key={scan.id}
              className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="flex min-w-0 items-start gap-3">
                <Folder size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium" title={scan.path}>
                    {scan.path}
                  </p>
                  <p className="text-xs text-text-secondary">
                    Completed{' '}
                    <time dateTime={scan.completedAt}>{formatScanDate(scan.completedAt)}</time>
                  </p>
                  {(scan.errorCount ?? 0) > 0 && (
                    <p className="text-xs text-warning">
                      Completed with {counts.format(scan.errorCount!)} filesystem{' '}
                      {scan.errorCount === 1 ? 'error' : 'errors'}. Incomplete result. Known totals
                      may be lower than the full directory size.
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
                      {counts.format(scan.totalBytes)} bytes
                    </span>
                  </dd>
                </div>
                <div className="space-y-1 sm:text-right">
                  <dt className="text-xs text-text-secondary">Files</dt>
                  <dd className="text-sm font-medium tabular-nums">
                    {counts.format(scan.fileCount)}
                  </dd>
                </div>
                {scan.directoryCount !== undefined && (
                  <div className="space-y-1 sm:text-right">
                    <dt className="text-xs text-text-secondary">Directories</dt>
                    <dd className="text-sm font-medium tabular-nums">
                      {counts.format(scan.directoryCount)}
                    </dd>
                  </div>
                )}
              </dl>
            </li>
          </ol>
        ) : (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
            <div className="rounded-lg border border-accent/15 bg-accent/10 p-3">
              <History size={22} className="text-accent" aria-hidden="true" />
            </div>
            <h4 className="text-base font-medium">No scans yet</h4>
            <p className="max-w-sm text-sm text-text-secondary">
              Completed scans will appear here with a summary of their storage usage.
            </p>
          </div>
        )}
      </Card>
    </div>
  )
}
