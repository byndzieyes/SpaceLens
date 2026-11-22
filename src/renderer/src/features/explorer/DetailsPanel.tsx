import { useEffect, useRef, useState } from 'react'
import { File, Folder, Link } from 'lucide-react'
import type { FileEntry } from '../../../../shared/scan'
import { formatBytes } from '../../lib/storage'
import { ExplorerRequestError, type ExplorerRequestFailure } from './ExplorerRequestError'

interface Props {
  scanId: string | null
  selectedEntryId: string | null
  disabled?: boolean
  initialEntry?: FileEntry
  onRefresh?: () => void
}

type DetailsState =
  | { status: 'loading' }
  | { status: 'loaded'; entry: FileEntry }
  | { status: 'error'; error: ExplorerRequestFailure }

const dates = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

function Timestamp({ value }: { value: string | null }): React.JSX.Element {
  const date = value ? new Date(value) : null
  return date && value && Number.isFinite(date.getTime()) ? (
    <time dateTime={value} title={date.toISOString()}>
      {dates.format(date)}
    </time>
  ) : (
    <span className="text-text-secondary">Not available</span>
  )
}

export function DetailsPanel({
  scanId,
  selectedEntryId,
  disabled,
  initialEntry,
  onRefresh
}: Props): React.JSX.Element {
  if (!scanId || !selectedEntryId)
    return (
      <div className="py-6 text-sm">
        <p className="font-medium">No item selected</p>
        <p className="mt-2 text-text-secondary">Select a file or directory to view its details.</p>
      </div>
    )

  return (
    <EntryDetails
      key={JSON.stringify([scanId, selectedEntryId])}
      scanId={scanId}
      entryId={selectedEntryId}
      disabled={disabled}
      initialEntry={
        initialEntry?.scanId === scanId && initialEntry.id === selectedEntryId
          ? initialEntry
          : undefined
      }
      onRefresh={onRefresh}
    />
  )
}

function EntryDetails({
  scanId,
  entryId,
  disabled,
  initialEntry,
  onRefresh
}: Pick<Props, 'disabled' | 'onRefresh' | 'initialEntry'> & {
  scanId: string
  entryId: string
}): React.JSX.Element {
  const [state, setState] = useState<DetailsState>(
    initialEntry ? { status: 'loaded', entry: initialEntry } : { status: 'loading' }
  )
  const [attempt, setAttempt] = useState(0)
  const focusTarget = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialEntry && attempt === 0) return
    let active = true
    // A discarded Strict Mode effect must not issue a duplicate request.
    queueMicrotask(async () => {
      if (!active) return
      try {
        const result = await window.spaceLens.getScanEntry({ scanId, entryId })
        if (!active) return
        if (!result.ok) setState({ status: 'error', error: result.error })
        else if (result.value.scanId !== scanId || result.value.id !== entryId)
          setState({
            status: 'error',
            error: {
              code: 'INVALID_REQUEST',
              message: 'Entry identity does not match this selection.'
            }
          })
        else setState({ status: 'loaded', entry: result.value })
      } catch {
        if (active)
          setState({
            status: 'error',
            error: { code: 'TRANSPORT_ERROR', message: 'Entry details could not be loaded.' }
          })
      }
    })
    return () => {
      active = false
    }
  }, [scanId, entryId, initialEntry, attempt])

  if (state.status !== 'loaded')
    return (
      <div ref={focusTarget} role="group" aria-label="Item details" tabIndex={-1} className="py-3">
        {state.status === 'loading' ? (
          <p role="status" className="py-3 text-sm text-text-secondary">
            Loading item details…
          </p>
        ) : (
          <ExplorerRequestError
            error={state.error}
            actionLabel="Retry item details"
            refreshLabel="Refresh snapshot for Details"
            disabled={disabled}
            onRefresh={onRefresh}
            onRetry={() => {
              focusTarget.current?.focus({ preventScroll: true })
              setState({ status: 'loading' })
              setAttempt((previous) => previous + 1)
            }}
          />
        )}
      </div>
    )

  const { entry } = state
  const Icon = entry.type === 'directory' ? Folder : entry.type === 'symlink' ? Link : File
  const size = entry.type === 'directory' ? entry.aggregatedSizeBytes : entry.sizeBytes
  return (
    <div
      ref={focusTarget}
      role="region"
      aria-label="Selected item metadata"
      tabIndex={0}
      className="min-w-0 space-y-5 pt-6 text-sm [overflow-wrap:anywhere] scrollbar-none focus-visible:-outline-offset-2 xl:max-h-96 xl:overflow-y-auto xl:pr-1"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="shrink-0 rounded-lg bg-surface-elevated p-2 text-text-secondary">
          <Icon size={22} aria-hidden="true" />
        </div>
        <h4 className="min-w-0 font-semibold">{entry.name}</h4>
      </div>
      <dl className="space-y-4">
        <div>
          <dt className="text-xs text-text-secondary">Type</dt>
          <dd className="mt-1">{entry.type}</dd>
        </div>
        {(entry.type === 'file' || entry.type === 'directory') && (
          <div>
            <dt className="text-xs text-text-secondary">
              {entry.type === 'directory' ? 'Aggregated size' : 'Logical size'}
            </dt>
            <dd className="mt-1 tabular-nums">
              {size === null ? (
                <span className="text-text-secondary">Not available</span>
              ) : (
                <span title={`${size.toLocaleString('en-US')} bytes`}>{formatBytes(size)}</span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-text-secondary">Full path</dt>
          <dd className="mt-1 font-mono text-xs select-text">{entry.path}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Created</dt>
          <dd className="mt-1">
            <Timestamp value={entry.createdAt} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Modified</dt>
          <dd className="mt-1">
            <Timestamp value={entry.modifiedAt} />
          </dd>
        </div>
      </dl>
    </div>
  )
}
