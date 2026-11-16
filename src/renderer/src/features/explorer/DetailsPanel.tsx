import { useEffect, useState } from 'react'
import { File, Folder, Link } from 'lucide-react'
import type { ScannerIpcResult } from '../../../../shared/ipc'
import type { FileEntry } from '../../../../shared/scan'
import { Button } from '../../components/ui/Button'
import { formatBytes } from '../../lib/storage'

interface Props {
  scanId: string | null
  selectedEntryId: string | null
}

type DetailsState =
  | { status: 'loading' }
  | { status: 'loaded'; entry: FileEntry }
  | {
      status: 'error'
      error:
        | Extract<ScannerIpcResult<never>, { ok: false }>['error']
        | { code: 'TRANSPORT_ERROR'; message: string }
    }

const dates = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'long',
  timeZone: 'UTC'
})

function Timestamp({ value }: { value: string | null }): React.JSX.Element {
  const date = value === null ? null : new Date(value)
  return date && Number.isFinite(date.getTime()) ? (
    <time dateTime={value!}>{dates.format(date)}</time>
  ) : (
    <span className="text-text-secondary">Not available</span>
  )
}

export function DetailsPanel({ scanId, selectedEntryId }: Props): React.JSX.Element {
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
    />
  )
}

function EntryDetails({ scanId, entryId }: { scanId: string; entryId: string }): React.JSX.Element {
  const [state, setState] = useState<DetailsState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
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
  }, [scanId, entryId, attempt])

  if (state.status === 'loading')
    return (
      <p role="status" className="py-6 text-sm text-text-secondary">
        Loading item details…
      </p>
    )

  if (state.status === 'error')
    return (
      <div className="space-y-4 py-6">
        <p role="alert" className="text-sm text-error [overflow-wrap:anywhere]">
          {state.error.code}: {state.error.message}
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            setState({ status: 'loading' })
            setAttempt((previous) => previous + 1)
          }}
        >
          Retry item details
        </Button>
      </div>
    )

  const { entry } = state
  const Icon = entry.type === 'directory' ? Folder : entry.type === 'symlink' ? Link : File
  const size = entry.type === 'directory' ? entry.aggregatedSizeBytes : entry.sizeBytes
  return (
    <div
      role="region"
      aria-label="Selected item metadata"
      tabIndex={0}
      className="min-w-0 max-h-96 space-y-5 overflow-y-auto pt-6 pr-1 text-sm [overflow-wrap:anywhere] focus-visible:-outline-offset-2"
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
          <dd className="mt-1">{entry.path}</dd>
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
