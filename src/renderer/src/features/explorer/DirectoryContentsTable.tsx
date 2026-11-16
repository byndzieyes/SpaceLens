import { useEffect, useId, useRef, useState } from 'react'
import { File, Folder, Link } from 'lucide-react'
import type { ScanDirectoryPage } from '../../../../shared/snapshot'
import { Button } from '../../components/ui/Button'
import { formatBytes } from '../../lib/storage'
import { listExplorerDirectoryPage } from './data'

interface Props {
  scanId: string | null
  directoryId: string | null
  selectedEntryId: string | null
  disabled?: boolean
  onSelect: (id: string | null) => void
  onNavigate: (id: string) => Promise<void>
}

export function DirectoryContentsTable(props: Props): React.JSX.Element {
  return <ContentsPage key={JSON.stringify([props.scanId, props.directoryId])} {...props} />
}

function ContentsPage({
  scanId,
  directoryId,
  selectedEntryId,
  disabled,
  onSelect,
  onNavigate
}: Props): React.JSX.Element {
  const [page, setPage] = useState<ScanDirectoryPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(!!scanId && !!directoryId)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const sequence = useRef(0)
  const retryOffset = useRef(0)
  const description = useId()
  const load = async (requested: number): Promise<void> => {
    if (!scanId || !directoryId || pending.current) return
    pending.current = true
    const ticket = ++sequence.current
    retryOffset.current = requested
    setLoading(true)
    setError(null)
    try {
      const result = await listExplorerDirectoryPage(
        { scanId, entryId: directoryId },
        { offset: requested, limit: 100 }
      )
      if (ticket !== sequence.current) return
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      setPage(result.value)
      setOffset(requested)
    } catch {
      if (ticket === sequence.current)
        setError('TRANSPORT_ERROR: Directory contents could not be loaded.')
    } finally {
      if (ticket === sequence.current) {
        pending.current = false
        setLoading(false)
      }
    }
  }
  useEffect(() => {
    const requests = sequence
    const inFlight = pending
    const ticket = requests.current
    // Defer the initial request so a discarded Strict Mode mount cannot issue it.
    queueMicrotask(() => {
      if (requests.current === ticket) void load(0)
    })
    return () => {
      requests.current++
      inFlight.current = false
    }
    // This keyed session owns one immutable snapshot/directory pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const changePage = (next: number): void => {
    if (pending.current || disabled) return
    onSelect(null)
    void load(next)
  }
  return (
    <>
      <p id={description} className="py-3 text-xs text-text-secondary">
        Logical file sizes and aggregated directory sizes. Click or Space selects; double-click or
        Enter opens a directory.
      </p>
      <div
        role="region"
        aria-label="Directory contents table"
        tabIndex={0}
        className="relative min-w-0 overflow-x-auto focus-visible:-outline-offset-2"
      >
        <table
          aria-describedby={description}
          className="w-full min-w-[26rem] table-fixed border-collapse text-left text-sm"
        >
          <caption className="sr-only">Files and directories in the displayed directory</caption>
          <thead className="border-b border-separator text-xs text-text-secondary">
            <tr>
              <th scope="col" className="w-1/2 py-3 pr-3">
                Name
              </th>
              <th scope="col" className="px-3 py-3">
                Type
              </th>
              <th scope="col" className="py-3 pl-3 text-right">
                Size
              </th>
            </tr>
          </thead>
          <tbody>
            {page?.entries.map((entry) => {
              const bytes =
                entry.type === 'directory'
                  ? entry.aggregatedSizeBytes
                  : entry.type === 'file'
                    ? entry.sizeBytes
                    : null
              const Icon =
                entry.type === 'directory' ? Folder : entry.type === 'symlink' ? Link : File
              const selected = entry.id === selectedEntryId
              const inactive = loading || disabled
              return (
                <tr
                  key={entry.id}
                  onClick={() => {
                    if (!inactive) onSelect(entry.id)
                  }}
                  onDoubleClick={() => {
                    if (!inactive && entry.type === 'directory') void onNavigate(entry.id)
                  }}
                  className={`border-b border-separator ${selected ? 'bg-accent/10 text-accent' : 'hover:bg-surface-hover'}`}
                >
                  <td className="py-1 pr-3">
                    <button
                      type="button"
                      disabled={inactive}
                      aria-pressed={selected}
                      title={entry.name}
                      className="flex w-full min-w-0 items-center gap-2 rounded py-2 text-left disabled:opacity-50"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && entry.type === 'directory') {
                          event.preventDefault()
                          void onNavigate(entry.id)
                        }
                      }}
                    >
                      <Icon size={16} className="shrink-0" aria-hidden="true" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </td>
                  <td className="px-3 py-3">{entry.type}</td>
                  <td
                    className="py-3 pl-3 text-right tabular-nums"
                    title={
                      bytes === null ? 'Size unavailable' : `${bytes.toLocaleString('en-US')} bytes`
                    }
                  >
                    {bytes === null ? (
                      <span aria-label="Size unavailable">—</span>
                    ) : (
                      formatBytes(bytes)
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {loading && (
        <p role="status" className="py-4 text-text-secondary">
          Loading directory contents…
        </p>
      )}
      {error && (
        <div className="py-4">
          <p role="alert" className="text-error [overflow-wrap:anywhere]">
            {error}
          </p>
          <Button
            variant="secondary"
            disabled={loading || disabled}
            onClick={() => void load(retryOffset.current)}
          >
            Retry directory contents
          </Button>
        </div>
      )}
      {!loading && !error && (!page || !page.entries.length) && (
        <p className="py-8 text-center text-text-secondary">
          {page?.totalCount === 0
            ? 'This directory is empty.'
            : !page
              ? 'No directory contents to display'
              : 'No entries on this page.'}
        </p>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-separator pt-4">
        <p className="text-xs text-text-secondary">
          {page
            ? `Page ${Math.floor(offset / 100) + 1} · ${page.totalCount.toLocaleString('en-US')} entries`
            : 'No page loaded'}
        </p>
        <div role="group" aria-label="Directory contents pagination" className="flex gap-2">
          <Button
            variant="secondary"
            aria-label="Previous page"
            disabled={!page || loading || disabled || offset === 0}
            onClick={() => changePage(Math.max(0, offset - 100))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            aria-label="Next page"
            disabled={!page || loading || disabled || page.nextOffset === null}
            onClick={() => {
              if (page?.nextOffset != null) changePage(page.nextOffset)
            }}
          >
            Next
          </Button>
        </div>
      </footer>
    </>
  )
}
