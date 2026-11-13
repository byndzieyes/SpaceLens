import { CircleCheck, CircleX, FolderSearch, LoaderCircle, TriangleAlert } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import type { useScanner } from './useScanner'

const counts = new Intl.NumberFormat('en-US')
const sizes = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** Decimal units, retaining small file sizes instead of rounding everything to GB. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const unit = bytes === 0 ? 0 : Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  return `${sizes.format(bytes / 1000 ** unit)} ${units[unit]}`
}

export function ScanPanel({
  scanner
}: {
  scanner: ReturnType<typeof useScanner>
}): React.JSX.Element {
  const { scan, cancelling, pending, ready, notice, error } = scanner
  const running = scan?.session.status === 'running'
  const status = scan?.session.status
  const incomplete = (scan?.session.summary.errorCount ?? 0) > 0
  const unavailable =
    status === 'completed' && scanner.snapshotUnavailable?.scanId === scan?.session.id
      ? scanner.snapshotUnavailable
      : null
  const label = cancelling
    ? 'Cancellation requested'
    : running
      ? 'Scanning'
      : status === 'completed'
        ? incomplete
          ? 'Completed with errors'
          : 'Scan completed'
        : status === 'cancelled'
          ? 'Scan cancelled'
          : status === 'failed'
            ? 'Scan failed'
            : ready
              ? 'Ready to scan'
              : 'Loading scan status'
  const activity =
    pending === 'selecting' ? 'Choosing a folder' : pending === 'starting' ? 'Starting scan' : label
  const Icon =
    running || pending
      ? LoaderCircle
      : status === 'failed' || incomplete
        ? TriangleAlert
        : status === 'completed'
          ? CircleCheck
          : status === 'cancelled'
            ? CircleX
            : FolderSearch
  const color =
    status === 'failed'
      ? 'text-error'
      : incomplete || status === 'cancelled'
        ? 'text-warning'
        : status === 'completed'
          ? 'text-success'
          : 'text-accent'
  const files = running ? scan.progress.processedFileCount : scan?.session.summary.fileCount
  const directories = running
    ? scan.progress.processedDirectoryCount
    : scan?.session.summary.directoryCount
  const bytes = running ? scan.progress.processedBytes : scan?.session.summary.totalBytes

  return (
    <Card aria-labelledby="scan-panel-title" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Icon
            size={20}
            aria-hidden="true"
            className={`${color} shrink-0 ${running || pending ? 'motion-safe:animate-spin' : ''}`}
          />
          <div>
            <h3 id="scan-panel-title" className="text-base font-semibold">
              Folder scan
            </h3>
            <p role="status" aria-atomic="true" className={`text-sm ${color}`}>
              {activity}
            </p>
          </div>
        </div>
        {running && (
          <Button variant="secondary" onClick={scanner.cancel} disabled={!!cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel Scan'}
          </Button>
        )}
      </div>
      {scan ? (
        <>
          <p className="truncate text-sm font-medium" title={scan.session.rootPath}>
            <span className="sr-only">Selected folder: </span>
            {scan.session.rootPath}
          </p>
          <dl className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-3">
            <div>
              <dt className="text-xs text-text-secondary">Files processed</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{counts.format(files!)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Directories processed</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {counts.format(directories!)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Known logical size</dt>
              <dd
                className="mt-1 text-lg font-semibold tabular-nums"
                title={`${counts.format(bytes!)} bytes`}
              >
                {formatBytes(bytes!)}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-text-secondary">
            Sum of known file sizes, not space allocated on disk.
          </p>
          {running && scan.progress.currentPath && (
            <p className="truncate text-xs text-text-secondary" title={scan.progress.currentPath}>
              Current path: {scan.progress.currentPath}
            </p>
          )}
          {cancelling && (
            <p className="text-sm text-text-secondary">
              Waiting for the scanner to stop. Confirmed totals are preserved.
            </p>
          )}
          {incomplete && (
            <p className="text-sm text-warning">
              {counts.format(scan.session.summary.errorCount)} filesystem{' '}
              {scan.session.summary.errorCount === 1 ? 'error' : 'errors'}. Results are incomplete;
              the known size may be lower than the full directory size.
            </p>
          )}
          {status === 'cancelled' && (
            <p className="text-sm text-text-secondary">
              The scan stopped before completion. These are partial totals.
            </p>
          )}
          {unavailable && (
            <p role="status" className="text-sm text-warning">
              Summary only.{' '}
              {unavailable.reason === 'limit-exceeded'
                ? 'The temporary snapshot storage limit was reached.'
                : 'Filesystem entries could not be retained.'}{' '}
              Scan statistics are available, but this scan has no browsable snapshot.
            </p>
          )}
          {status === 'failed' && (
            <p role="alert" className="text-sm text-error">
              {scan.failure?.message || 'The scan could not be completed.'} Available totals are
              partial.
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-text-secondary">
          Choose Scan Folder to measure a directory’s logical file sizes.
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-text-secondary">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {!ready && error && (
        <Button variant="secondary" onClick={scanner.refresh}>
          Refresh status
        </Button>
      )}
    </Card>
  )
}
