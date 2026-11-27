import { useRef } from 'react'
import { Search, X } from 'lucide-react'
import type { ScanHistoryPage, ScanHistorySort } from '../../../shared/history'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Pagination } from '../components/ui/Pagination'
import { HistoryTable } from '../features/history/HistoryTable'
import { useScanHistory } from '../features/history/useScanHistory'
import type { SnapshotSelections } from '../features/snapshots/selection'

const counts = new Intl.NumberFormat('en-US')
const sortOptions = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  'size-desc': 'Largest size first',
  'size-asc': 'Smallest size first'
} satisfies Record<ScanHistorySort, string>

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

export function HistoryPage({ snapshots }: { snapshots: SnapshotSelections }): React.JSX.Element {
  const history = useScanHistory(snapshots)
  const filterInput = useRef<HTMLInputElement>(null)
  const { state, filter } = history
  const { page } = state
  const hasRows = !!page?.items.length
  const clearFilter = (): void => {
    history.setFilter('')
    filterInput.current?.focus()
  }

  return (
    <div className="min-w-0 space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Scan History</h2>
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
                onChange={(event) => history.setSort(event.currentTarget.value as ScanHistorySort)}
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

        <Pagination
          className="border-t border-separator pt-3"
          label="History pagination"
          previousLabel="Previous history page"
          nextLabel="Next history page"
          range={
            page && (hasRows || state.status === 'ready') ? describePage(page, !!filter) : null
          }
          previous={history.previous}
          next={history.next}
        />

        {page && hasRows && <HistoryTable page={page} />}
        {state.status === 'ready' && !hasRows && (
          <div className="space-y-2 rounded-lg border border-separator bg-background/40 px-4 py-6">
            <p className="font-medium">{filter ? 'No matching snapshots' : 'No saved scans yet'}</p>
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
    </div>
  )
}
