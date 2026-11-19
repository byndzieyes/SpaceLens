import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import type { FileEntry } from '../../../../shared/scan'
import type { ScanSnapshot } from '../../../../shared/snapshot'
import { isStaleSnapshotError, listExplorerDirectoryPage } from './data'
import { ExplorerRequestError, type ExplorerRequestFailure } from './ExplorerRequestError'

interface TreeProps {
  snapshot: ScanSnapshot
  currentDirectoryId: string | null
  navigationDisabled?: boolean
  onNavigate: (entryId: string) => Promise<void>
  onRefresh?: () => void
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
    <div className="max-h-96 min-w-0 overflow-y-auto py-3 scrollbar-none md:min-h-0 md:max-h-none md:flex-1 md:contain-size">
      <ul aria-label="Snapshot directories">
        <DirectoryNode {...props} entry={props.snapshot.root} budget={budget} depth={0} />
      </ul>
    </div>
  )
}

function DirectoryNode({
  entry,
  budget,
  depth,
  ...tree
}: TreeProps & { entry: FileEntry; budget: Set<string>; depth: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState<Page | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ExplorerRequestFailure | null>(null)
  const expander = useRef<HTMLButtonElement>(null)
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
      setError({
        code: 'Tree page limit reached',
        message: 'Collapse a branch to release its children, then retry.'
      })
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
        setError(result.error)
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
        setError({ code: 'TRANSPORT_ERROR', message: 'Directory page could not be loaded.' })
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
  const indent = `${Math.min(depth, 4) * 0.5}rem`
  const pagingDisabled = loading || !!tree.navigationDisabled || isStaleSnapshotError(error?.code)
  const previousDisabled = pagingDisabled || page?.offset === 0
  const nextDisabled = pagingDisabled || page?.nextOffset === null
  return (
    <li className="min-w-0">
      <div
        className="flex min-w-0 items-start gap-1 rounded-md py-1"
        style={{ paddingInlineStart: indent }}
      >
        <button
          type="button"
          ref={expander}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
          aria-expanded={expanded}
          aria-controls={groupId}
          onClick={toggle}
          className="mt-1 shrink-0 rounded p-1 text-text-secondary hover:bg-surface-hover focus-visible:-outline-offset-2"
        >
          {expanded ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!tree.navigationDisabled) void tree.onNavigate(entry.id)
          }}
          aria-disabled={tree.navigationDisabled || undefined}
          tabIndex={tree.navigationDisabled ? -1 : undefined}
          aria-current={tree.currentDirectoryId === entry.id ? 'location' : undefined}
          title={entry.path}
          className={`flex min-w-0 flex-1 items-start gap-1.5 rounded px-1.5 py-1.5 text-left text-sm aria-disabled:opacity-50 focus-visible:-outline-offset-2 ${tree.currentDirectoryId === entry.id ? 'bg-accent/10 font-semibold text-accent inset-ring-1 inset-ring-accent/60' : 'text-text-primary hover:bg-surface-hover'}`}
        >
          <Folder size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2 [overflow-wrap:anywhere]">{name}</span>
        </button>
      </div>
      <div id={groupId} hidden={!expanded} className="min-w-0">
        {expanded && (
          <>
            {loading && (
              <p
                role="status"
                style={{ marginInlineStart: indent }}
                className="py-2 text-xs text-text-secondary [overflow-wrap:anywhere]"
              >
                Loading directories in {name}…
              </p>
            )}
            {error && (
              <div style={{ marginInlineStart: indent }}>
                <ExplorerRequestError
                  error={error}
                  actionLabel={`Retry ${name}`}
                  refreshLabel={`Refresh snapshot for ${name} in Directory Tree`}
                  disabled={tree.navigationDisabled}
                  onRefresh={tree.onRefresh}
                  onRetry={() => {
                    expander.current?.focus({ preventScroll: true })
                    void load(retryOffset.current)
                  }}
                />
              </div>
            )}
            {page && (
              <>
                {!page.directories.length && (
                  <p
                    className="py-2 text-xs text-text-secondary"
                    style={{ marginInlineStart: indent }}
                  >
                    {page.offset === 0 && page.nextOffset === null
                      ? 'No subdirectories'
                      : page.nextOffset !== null
                        ? 'No directories on this page. More entries are available on the next page.'
                        : 'No directories on this page.'}
                  </p>
                )}
                <ul key={page.offset} aria-label={`Subdirectories of ${name}`}>
                  {page.directories.map((child) => (
                    <DirectoryNode
                      key={child.id}
                      {...tree}
                      entry={child}
                      budget={budget}
                      depth={depth + 1}
                    />
                  ))}
                </ul>
                {(page.offset > 0 || page.nextOffset !== null) && (
                  <div
                    role="group"
                    aria-label={`Pages for ${name}`}
                    className="flex flex-wrap gap-1.5 py-2 text-xs"
                    style={{ marginInlineStart: indent }}
                  >
                    <span aria-live="polite" className="w-full text-text-secondary">
                      Page {Math.floor(page.offset / PAGE_SIZE) + 1} of{' '}
                      {Math.max(1, Math.ceil(page.totalCount / PAGE_SIZE))} ·{' '}
                      {page.totalCount.toLocaleString('en-US')} entries
                    </span>
                    <button
                      type="button"
                      aria-disabled={previousDisabled}
                      tabIndex={previousDisabled ? -1 : undefined}
                      onClick={() => {
                        if (!previousDisabled) void load(page.offset - PAGE_SIZE)
                      }}
                      className="rounded border border-border px-2 py-1 enabled:hover:bg-surface-hover aria-disabled:opacity-50 focus-visible:-outline-offset-2"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      aria-disabled={nextDisabled}
                      tabIndex={nextDisabled ? -1 : undefined}
                      onClick={() => {
                        if (!nextDisabled && page.nextOffset !== null) void load(page.nextOffset)
                      }}
                      className="rounded border border-border px-2 py-1 enabled:hover:bg-surface-hover aria-disabled:opacity-50 focus-visible:-outline-offset-2"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </li>
  )
}
