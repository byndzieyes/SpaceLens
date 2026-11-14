import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import type { FileEntry } from '../../../../shared/scan'
import type { ScanSnapshot } from '../../../../shared/snapshot'
import { listExplorerDirectoryPage } from './data'

interface TreeProps {
  snapshot: ScanSnapshot
  currentDirectoryId: string | null
  navigationDisabled?: boolean
  onNavigate: (entryId: string) => Promise<void>
}
interface Page {
  offset: number
  directories: readonly FileEntry[]
  totalCount: number
  nextOffset: number | null
}
const PAGE_SIZE = 100
const MAX_RETAINED_PAGES = 32

/** Key the session by scan ID: no old snapshot's nodes or pending results survive. */
export function DirectoryTree(props: TreeProps): React.JSX.Element {
  return <TreeSession key={props.snapshot.entries.scanId} {...props} />
}

function TreeSession(props: TreeProps): React.JSX.Element {
  const [budget] = useState(() => new Set<string>())
  return (
    <div className="min-w-0 max-h-96 overflow-auto py-3">
      <p className="mb-3 text-xs text-text-secondary">
        Pages include files; some pages may contain no directories. Breadcrumbs show your current
        location.
      </p>
      <ul aria-label="Snapshot directories">
        <DirectoryNode {...props} entry={props.snapshot.root} budget={budget} />
      </ul>
    </div>
  )
}

function DirectoryNode({
  entry,
  budget,
  ...tree
}: TreeProps & { entry: FileEntry; budget: Set<string> }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState<Page | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const generation = useRef(0)
  const retryOffset = useRef(0)
  const groupId = useId()
  useEffect(() => {
    const requests = generation
    return () => {
      requests.current++
      budget.delete(entry.id)
    }
  }, [budget, entry.id])

  const load = async (offset: number): Promise<void> => {
    if (pending.current) return
    retryOffset.current = offset
    if (!budget.has(entry.id) && budget.size >= MAX_RETAINED_PAGES) {
      setError(
        'Tree page limit reached. Collapse an ancestor branch to release its children, then retry.'
      )
      return
    }
    budget.add(entry.id)
    pending.current = true
    const ticket = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await listExplorerDirectoryPage(
        { scanId: tree.snapshot.entries.scanId, entryId: entry.id },
        { offset, limit: PAGE_SIZE }
      )
      if (ticket !== generation.current) return
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      setPage({
        offset,
        directories: result.value.entries.filter((child) => child.type === 'directory'),
        totalCount: result.value.totalCount,
        nextOffset: result.value.nextOffset
      })
    } catch {
      if (ticket === generation.current)
        setError('TRANSPORT_ERROR: Directory page could not be loaded.')
    } finally {
      if (ticket === generation.current) {
        pending.current = false
        setLoading(false)
      }
    }
  }
  const toggle = (): void => {
    setExpanded(!expanded)
    if (!expanded && !page && !error) void load(0)
  }
  const name = entry.name || entry.path
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-1 rounded-md py-1">
        <button
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
          aria-expanded={expanded}
          aria-controls={groupId}
          onClick={toggle}
          className="shrink-0 rounded p-1 text-text-secondary hover:bg-surface-hover"
        >
          {expanded ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => void tree.onNavigate(entry.id)}
          disabled={tree.navigationDisabled}
          aria-current={tree.currentDirectoryId === entry.id ? 'location' : undefined}
          title={entry.path}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-2 text-left text-sm disabled:opacity-50 ${tree.currentDirectoryId === entry.id ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-surface-hover'}`}
        >
          <Folder size={16} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{name}</span>
        </button>
      </div>
      <div id={groupId} hidden={!expanded} className="ml-2 min-w-0 border-l border-separator pl-2">
        {expanded && (
          <>
            {loading && (
              <p role="status" className="py-2 text-xs text-text-secondary">
                Loading directories in {name}…
              </p>
            )}
            {error && (
              <div className="py-2 text-xs [overflow-wrap:anywhere]">
                <p role="alert" className="text-error">
                  {error}
                </p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void load(retryOffset.current)}
                  className="py-2 text-accent hover:underline"
                >
                  Retry {name}
                </button>
              </div>
            )}
            {page && (
              <>
                {!page.directories.length && (
                  <p className="py-2 text-xs text-text-secondary">
                    {page.offset === 0 && page.nextOffset === null
                      ? 'No subdirectories'
                      : page.nextOffset !== null
                        ? 'No directories on this page. More entries are available on the next page.'
                        : 'No directories on this page.'}
                  </p>
                )}
                <ul key={page.offset} aria-label={`Subdirectories of ${name}`}>
                  {page.directories.map((child) => (
                    <DirectoryNode key={child.id} {...tree} entry={child} budget={budget} />
                  ))}
                </ul>
                <div
                  role="group"
                  aria-label={`Pages for ${name}`}
                  className="flex flex-wrap gap-2 py-2 text-xs"
                >
                  <span className="w-full text-text-secondary">
                    {page.totalCount} entries (files and directories)
                  </span>
                  <button
                    type="button"
                    disabled={loading || page.offset === 0}
                    onClick={() => void load(Math.max(0, page.offset - PAGE_SIZE))}
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={loading || page.nextOffset === null}
                    onClick={() => {
                      if (page.nextOffset !== null) void load(page.nextOffset)
                    }}
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </li>
  )
}
