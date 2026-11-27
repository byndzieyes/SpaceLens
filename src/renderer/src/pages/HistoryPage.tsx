import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ScanHistoryItem, ScanHistoryPage, ScanHistorySort } from '../../../shared/history'
import type { SnapshotView } from '../../../shared/snapshotSelection'
import type { ScannerIpcErrorCode } from '../../../shared/ipc'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Pagination } from '../components/ui/Pagination'
import { HistoryTable } from '../features/history/HistoryTable'
import { DeleteSnapshotDialog } from '../features/history/DeleteSnapshotDialog'
import { HistorySettings, type HistoryFeedback } from '../features/history/HistorySettings'
import { useScanHistory } from '../features/history/useScanHistory'
import type { SnapshotSelections } from '../features/snapshots/selection'
import type {
  OpenHistoricalEntry,
  SnapshotOpenFailure
} from '../features/snapshots/useSnapshotNavigation'
import { ComparisonWorkspace } from '../features/comparison/ComparisonWorkspace'
import type { ComparisonDraft } from '../features/comparison/draft'
import type { ComparisonMutations } from '../features/comparison/selection'
import { TrendsWorkspace } from '../features/trends/TrendsWorkspace'

const counts = new Intl.NumberFormat('en-US')
const sortOptions = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  'size-desc': 'Largest size first',
  'size-asc': 'Smallest size first'
} satisfies Record<ScanHistorySort, string>
const historyTabs = { scans: 'Scans', comparison: 'Comparison', trends: 'Trends' } as const
type HistoryTab = keyof typeof historyTabs
const tabs: readonly HistoryTab[] = ['scans', 'comparison', 'trends']

function describePage(page: ScanHistoryPage, filtered: boolean): string {
  const { offset, limit, totalCount, items } = page
  if (totalCount === 0) return filtered ? '0 matching scans' : '0 saved scans'
  const first = counts.format(offset + 1)
  const last = counts.format(offset + items.length)
  const total = counts.format(totalCount)
  const currentPage = counts.format(Math.floor(offset / limit) + 1)
  const totalPages = counts.format(Math.ceil(totalCount / limit))
  const noun = totalCount === 1 ? 'scan' : 'scans'
  return `Showing ${first}–${last} of ${total} ${filtered ? 'matching ' : ''}${noun} · Page ${currentPage} of ${totalPages}`
}

function openError(code: ScannerIpcErrorCode): string {
  switch (code) {
    case 'SNAPSHOT_EXPIRED':
      return 'This snapshot is no longer retained.'
    case 'SNAPSHOT_UNAVAILABLE':
      return 'This saved snapshot is unavailable.'
    case 'UNAVAILABLE':
      return 'Saved scan storage is busy or unavailable. Try opening the snapshot again.'
    default:
      return 'The saved snapshot could not be opened.'
  }
}

export function HistoryPage({
  snapshots,
  comparisonMutations,
  onOpenSnapshot,
  onOpenEntry,
  onCancelOpen
}: {
  snapshots: SnapshotSelections
  comparisonMutations: ComparisonMutations
  onOpenSnapshot: (view: SnapshotView, scanId: string, onNotOpened: SnapshotOpenFailure) => void
  onOpenEntry?: OpenHistoricalEntry
  onCancelOpen?: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<HistoryTab>('scans')
  const [comparisonDraft, setComparisonDraft] = useState<ComparisonDraft>()
  const tabId = useId()
  const tabButtons = useRef<Partial<Record<HistoryTab, HTMLButtonElement | null>>>({})
  const showScans = tab === 'scans'
  const history = useScanHistory(snapshots, showScans)
  const filterInput = useRef<HTMLInputElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<ScanHistoryItem | null>(null)
  const [feedback, setFeedback] = useState<HistoryFeedback>()
  const [opening, setOpening] = useState<SnapshotView>()
  const attempt = useRef<symbol>(undefined)
  const { state, filter } = history
  const { page } = state
  const hasRows = !!page?.items.length
  const clearFilter = (): void => {
    history.setFilter('')
    filterInput.current?.focus()
  }

  useLayoutEffect(
    () => () => {
      attempt.current = undefined
    },
    []
  )

  const openSnapshot = (view: SnapshotView, scan: Pick<ScanHistoryItem, 'id'>): void => {
    const request = Symbol()
    attempt.current = request
    setOpening(view)
    setFeedback(undefined)
    onOpenSnapshot(view, scan.id, (code) => {
      if (attempt.current !== request) return
      attempt.current = undefined
      setOpening(undefined)
      if (code) setFeedback({ status: 'error', message: openError(code) })
      if (code === 'SNAPSHOT_EXPIRED') history.retry()
    })
  }
  const cancelOpening = (): void => {
    if (!attempt.current) return
    attempt.current = undefined
    setOpening(undefined)
    onCancelOpen?.()
  }
  const selectTab = (next: HistoryTab): void => {
    if (next !== tab) {
      cancelOpening()
      setFeedback(undefined)
    }
    setTab(next)
  }
  const compareSnapshot = (scan: ScanHistoryItem): void => {
    setComparisonDraft((previous) => ({ baseline: scan, target: previous?.target }))
    selectTab('comparison')
    tabButtons.current.comparison?.focus()
  }

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={title} tabIndex={-1} className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Scan History
        </h2>
        {showScans && (
          <HistorySettings
            historyRevision={history.historyRevision}
            retainedCount={history.retainedCount}
            onOpen={cancelOpening}
            report={setFeedback}
          />
        )}
      </header>
      <div
        role="tablist"
        aria-label="History views"
        className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-border bg-background/40 p-1"
      >
        {tabs.map((name, index) => (
          <button
            key={name}
            ref={(node) => {
              tabButtons.current[name] = node
            }}
            id={`${tabId}-${name}-tab`}
            aria-controls={`${tabId}-${name}-panel`}
            aria-selected={name === tab}
            tabIndex={name === tab ? 0 : -1}
            role="tab"
            type="button"
            onClick={() => selectTab(name)}
            onKeyDown={(event) => {
              const key = event.key
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return
              event.preventDefault()
              const next =
                key === 'Home'
                  ? 'scans'
                  : key === 'End'
                    ? 'trends'
                    : tabs[(index + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
              tabButtons.current[next]?.focus()
            }}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-hover aria-selected:bg-surface-elevated aria-selected:text-text-primary"
          >
            {historyTabs[name]}
          </button>
        ))}
      </div>
      <div
        id={`${tabId}-scans-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-scans-tab`}
        tabIndex={0}
        hidden={!showScans}
        className="rounded-xl"
      >
        {showScans && (
          <>
            <Card aria-labelledby="saved-snapshots-title" className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
                <h3 id="saved-snapshots-title" className="text-base font-semibold">
                  Saved Snapshots
                </h3>
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <div className="relative w-60 min-w-0 max-w-full">
                    <label htmlFor="history-path-filter" className="sr-only">
                      Filter by path
                    </label>
                    <Search
                      size={16}
                      aria-hidden="true"
                      className="pointer-events-none absolute top-3 left-3 text-text-secondary"
                    />
                    <input
                      ref={filterInput}
                      id="history-path-filter"
                      type="search"
                      value={filter}
                      placeholder="Filter by path"
                      onChange={(event) => history.setFilter(event.currentTarget.value)}
                      className="h-10 w-full min-w-0 rounded-md border border-border bg-background pr-10 pl-9 text-sm text-text-primary outline-offset-1 placeholder:text-text-secondary [&::-webkit-search-cancel-button]:appearance-none"
                    />
                    {filter && (
                      <button
                        type="button"
                        aria-label="Clear path filter"
                        onClick={clearFilter}
                        className="absolute top-1 right-1 inline-flex size-8 items-center justify-center rounded-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-text-secondary">
                    <span>Sort</span>
                    <select
                      value={history.sort}
                      onChange={(event) =>
                        history.setSort(event.currentTarget.value as ScanHistorySort)
                      }
                      className="h-10 min-w-0 rounded-md border border-border bg-background px-3 text-text-primary outline-offset-1"
                    >
                      {Object.entries(sortOptions).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              {state.status === 'loading' && (
                <p role="status" className="text-sm text-text-secondary">
                  {page ? 'Refreshing saved snapshots…' : 'Loading saved snapshots…'}
                </p>
              )}
              {state.status === 'error' && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p role="alert" className="text-sm text-error">
                    {state.message}
                    {hasRows && ' Showing the last loaded page.'}
                  </p>
                  <Button variant="secondary" onClick={history.retry}>
                    Retry
                  </Button>
                </div>
              )}
              {opening && (
                <p role="status" className="text-sm text-text-secondary">
                  Opening saved snapshot in {opening === 'explorer' ? 'Explorer' : 'Insights'}…
                </p>
              )}
              {feedback && (
                <p
                  role={feedback.status === 'error' ? 'alert' : 'status'}
                  className={
                    feedback.status === 'error' ? 'text-sm text-error' : 'text-sm text-success'
                  }
                >
                  {feedback.message}
                </p>
              )}

              <Pagination
                className="border-t border-separator pt-3"
                label="History pagination"
                previousLabel="Previous history page"
                nextLabel="Next history page"
                range={
                  page && (hasRows || state.status === 'ready')
                    ? describePage(page, !!filter)
                    : null
                }
                previous={history.previous}
                next={history.next}
              />

              {page && hasRows && (
                <HistoryTable
                  page={page}
                  onOpen={openSnapshot}
                  onCompare={compareSnapshot}
                  onDelete={(scan) => {
                    cancelOpening()
                    setFeedback(undefined)
                    setDeleteTarget(scan)
                  }}
                  fallbackFocus={title}
                />
              )}
              {state.status === 'ready' && !hasRows && (
                <div className="space-y-2 rounded-lg border border-separator bg-background/40 px-4 py-6">
                  <p className="font-medium">
                    {filter ? 'No matching snapshots' : 'No saved scans yet'}
                  </p>
                  {filter ? (
                    <Button variant="secondary" onClick={clearFilter}>
                      Clear filter
                    </Button>
                  ) : (
                    <p className="text-sm text-text-secondary">
                      Saved scans appear here after a scan completes.
                    </p>
                  )}
                </div>
              )}
            </Card>
            {deleteTarget && (
              <DeleteSnapshotDialog
                scan={deleteTarget}
                latest={deleteTarget.id === history.latestCompletedScanId}
                fallbackFocus={title}
                onDismiss={() => setDeleteTarget(null)}
                refreshHistory={history.retry}
                onDeleted={() => {
                  setDeleteTarget(null)
                  setFeedback({ status: 'success', message: 'Saved snapshot deleted.' })
                }}
              />
            )}
          </>
        )}
      </div>
      <div
        id={`${tabId}-comparison-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-comparison-tab`}
        tabIndex={0}
        hidden={tab !== 'comparison'}
        className="rounded-xl"
      >
        {tab === 'comparison' && (
          <ComparisonWorkspace
            onOpenEntry={onOpenEntry}
            draft={comparisonDraft}
            setDraft={setComparisonDraft}
            historyRevision={history.historyRevision}
            scanActive={history.scanActive}
            mutations={comparisonMutations}
          />
        )}
      </div>
      <div
        id={`${tabId}-trends-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-trends-tab`}
        tabIndex={0}
        hidden={tab !== 'trends'}
        className="rounded-xl"
      >
        <TrendsWorkspace
          active={tab === 'trends'}
          historyRevision={history.historyRevision}
          opening={tab === 'trends' ? opening : undefined}
          feedback={tab === 'trends' ? feedback : undefined}
          onOpen={(view, id) => openSnapshot(view, { id })}
          onOpenPicker={cancelOpening}
        />
      </div>
    </div>
  )
}
