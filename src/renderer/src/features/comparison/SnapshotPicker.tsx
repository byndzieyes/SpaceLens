import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Folder } from 'lucide-react'
import type { ComparisonSide } from '../../../../shared/comparison'
import {
  DEFAULT_SCAN_HISTORY_PAGE_SIZE,
  type ScanHistoryItem,
  type ScanHistoryPage
} from '../../../../shared/history'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { Pagination } from '../../components/ui/Pagination'
import { formatPreciseScanDate } from '../../lib/scanDisplay'
import { formatBytes } from '../../lib/storage'
import { sideLabels, useComparisonHistory } from './draft'

const counts = new Intl.NumberFormat('en-US')
const pageSize = DEFAULT_SCAN_HISTORY_PAGE_SIZE

export function SnapshotDetails({
  scan,
  latest = scan.isLatest
}: {
  scan: ScanHistoryItem
  latest?: boolean
}): React.JSX.Element {
  return (
    <span className="block min-w-0 space-y-1.5">
      <span
        title={scan.rootPath}
        className="line-clamp-2 text-sm font-medium break-all whitespace-pre-wrap"
      >
        {scan.rootPath}
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary tabular-nums">
        <time dateTime={scan.finishedAt}>{formatPreciseScanDate(scan.finishedAt)}</time>
        <span title="Known logical size">{formatBytes(scan.summary.totalBytes)} known</span>
        <span>
          {counts.format(scan.summary.fileCount)} {scan.summary.fileCount === 1 ? 'file' : 'files'}
        </span>
      </span>
      {(latest || scan.incomplete) && (
        <span className="flex flex-wrap gap-1.5">
          {latest && <Badge>Latest</Badge>}
          {scan.incomplete && <Badge variant="warning">Partial scan</Badge>}
        </span>
      )}
    </span>
  )
}

export function SnapshotPicker({
  side,
  selectedId,
  recent,
  historyRevision,
  onSelect,
  onDismiss
}: {
  side: ComparisonSide
  selectedId?: string
  recent: ReturnType<typeof useComparisonHistory>
  historyRevision: number
  onSelect: (scan: ScanHistoryItem) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [filter, setFilter] = useState('')
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    if (filter === input) return
    const timer = setTimeout(() => {
      setFilter(input)
      setOffset(0)
    }, 250)
    return () => clearTimeout(timer)
  }, [filter, input])

  const query = useMemo(
    () =>
      filter || offset
        ? { limit: pageSize, offset, ...(filter && { rootPathContains: filter }) }
        : undefined,
    [filter, offset]
  )
  const queried = useComparisonHistory(query, historyRevision)
  const { page, loading, error, retry } = query ? queried : recent
  const visible = filter === input ? page : undefined
  const pending = loading || filter !== input
  const range = (value: ScanHistoryPage): string =>
    value.items.length
      ? `${counts.format(value.offset + 1)}–${counts.format(value.offset + value.items.length)} of ${counts.format(value.totalCount)} snapshots`
      : `${counts.format(value.totalCount)} snapshots`

  return (
    <Modal title={`Choose ${sideLabels[side].toLowerCase()} snapshot`} onDismiss={onDismiss}>
      <div className="space-y-4">
        <label className="block space-y-1.5 text-sm">
          <span>Filter by path</span>
          <input
            data-autofocus
            type="search"
            maxLength={32767}
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            className="h-10 w-full min-w-0 rounded-md border border-border bg-background px-3 text-text-primary"
          />
        </label>
        <Pagination
          label="Snapshot picker pagination"
          previousLabel="Previous snapshots"
          nextLabel="Next snapshots"
          range={visible ? range(visible) : null}
          previous={offset > 0 && !pending ? () => setOffset(Math.max(0, offset - pageSize)) : null}
          next={visible?.nextOffset != null ? () => setOffset(visible.nextOffset!) : null}
        />
        {pending && (
          <p role="status" className="text-sm text-text-secondary">
            Loading snapshots…
          </p>
        )}
        {!pending && error && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm text-error">
              Saved snapshots could not be loaded.
            </p>
            <Button variant="secondary" onClick={retry}>
              Retry
            </Button>
          </div>
        )}
        {visible?.items.length === 0 && (
          <p className="text-sm text-text-secondary">
            {visible.totalCount
              ? 'This page is empty. Go back to see earlier pages.'
              : filter
                ? 'No matching snapshots'
                : 'No saved snapshots'}
          </p>
        )}
        {visible && visible.items.length > 0 && (
          <ul className="divide-y divide-separator overflow-hidden rounded-md border border-border">
            {visible.items.map((scan) => (
              <li key={scan.id}>
                <button
                  type="button"
                  aria-pressed={scan.id === selectedId}
                  onClick={() => onSelect(scan)}
                  className="flex w-full min-w-0 items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-hover focus-visible:-outline-offset-2 aria-pressed:bg-surface-active"
                >
                  <Folder size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
                  <SnapshotDetails scan={scan} latest={scan.id === visible.latestCompletedScanId} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onDismiss}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function SnapshotSelector({
  side,
  scan,
  latest,
  status,
  disabled,
  onOpen
}: {
  side: ComparisonSide
  scan?: ScanHistoryItem
  latest?: boolean
  status: 'empty' | 'ready' | 'loading' | 'missing' | 'unavailable'
  disabled: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <section
      aria-label={sideLabels[side]}
      className="min-w-0 space-y-2 rounded-lg border border-separator bg-background/35 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{sideLabels[side]}</h4>
        <Button
          variant="secondary"
          className="min-h-8 px-2.5 py-1"
          aria-label={`Choose ${side} snapshot`}
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={onOpen}
        >
          {scan ? 'Change' : 'Choose snapshot'} <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </div>
      {scan && <SnapshotDetails scan={scan} latest={latest} />}
      {status === 'missing' && (
        <p className="text-sm text-error">This snapshot is no longer retained.</p>
      )}
      {status === 'unavailable' && (
        <p className="text-sm text-error">Snapshot metadata is unavailable.</p>
      )}
      {status === 'loading' && <p className="text-sm text-text-secondary">Checking snapshot…</p>}
      {status === 'empty' && (
        <p className="text-sm text-text-secondary">Choose a {side} snapshot.</p>
      )}
    </section>
  )
}
