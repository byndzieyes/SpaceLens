import { useId, useMemo, useRef, useState } from 'react'
import type {
  AdoptedComparisonSelection,
  ComparisonDirectoryChange,
  ComparisonDirectoryQuery,
  ComparisonErrorCode,
  ComparisonPair,
  ComparisonReadRequest,
  ComparisonSort,
  EntryChangeKind
} from '../../../../shared/comparison'
import { DEFAULT_COMPARISON_PAGE_SIZE } from '../../../../shared/comparison'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Pagination } from '../../components/ui/Pagination'
import {
  ChangeActions,
  ChangePath,
  ChangeTable,
  type OpenComparisonEntry,
  type ScopeChange
} from './ChangeTables'
import { ComparisonBytes } from './ComparisonBytes'
import { comparisonCounts as counts, fileKinds } from './changeDisplay'
import { DetailedQueryQueue, useDetailedPage } from './useDetailedPage'

type DetailView = 'files' | 'directories'
export type ChangeNavigation = { status: 'opening' | 'error'; message: string }
type Ranking = 'growth' | 'reduction'
interface PageSettings {
  readonly kind: EntryChangeKind | ''
  readonly sort: ComparisonSort
  readonly offset: number
}

const views = { files: 'File Changes', directories: 'Directory Changes' } as const
const options = Object.keys(views) as DetailView[]
const kinds = Object.keys(fileKinds) as EntryChangeKind[]
const startingPage: PageSettings = { kind: '', sort: 'path', offset: 0 }
const limit = DEFAULT_COMPARISON_PAGE_SIZE
const rankingLimit = 5
const sorts = {
  path: 'Path order',
  'delta-desc': 'Largest growth',
  'delta-asc': 'Largest reduction'
} satisfies Record<ComparisonSort, string>
const direction = { growth: 'delta-desc', reduction: 'delta-asc' } as const
const rankingNames = {
  growth: 'Largest growing directories',
  reduction: 'Largest shrinking directories'
} as const
type PageRange = {
  offset: number
  limit: number
  totalCount: number
  nextOffset: number | null
  items: readonly unknown[]
}

function range(page: PageRange): string {
  if (!page.totalCount) return '0 records'
  return `Showing ${counts.format(page.offset + 1)}–${counts.format(page.offset + page.items.length)} of ${counts.format(page.totalCount)} records · Page ${counts.format(Math.floor(page.offset / page.limit) + 1)} of ${counts.format(Math.ceil(page.totalCount / page.limit))}`
}

function errorMessage(code: ComparisonErrorCode, scanActive: boolean | undefined): string {
  switch (code) {
    case 'COMPARISON_SCAN_ACTIVE':
      return scanActive
        ? 'Detailed changes are temporarily unavailable while a scan is active.'
        : 'A scan paused this request. Retry when the scanner is idle.'
    case 'COMPARISON_TIMEOUT':
      return 'The detailed query timed out. Saved scan storage may need to recover before you retry.'
    case 'UNAVAILABLE':
    case 'UNAUTHORIZED':
      return 'Saved scan storage is unavailable. Reopen SpaceLens if this persists.'
    case 'SNAPSHOT_EXPIRED':
    case 'SNAPSHOT_UNAVAILABLE':
      return 'This comparison is no longer available. Adopt the pair again.'
    case 'SIZE_OVERFLOW':
      return 'The detailed totals exceed the supported numeric range.'
    default:
      return 'Detailed changes could not be loaded.'
  }
}

function ReadStatus({
  status,
  label,
  scanActive,
  retry
}: {
  status: { status: 'idle' | 'loading' | 'ready' } | { status: 'error'; code: ComparisonErrorCode }
  label: string
  scanActive: boolean | undefined
  retry: () => void
}): React.JSX.Element | null {
  if (status.status === 'loading')
    return (
      <p role="status" className="text-sm text-text-secondary">
        {label}…
      </p>
    )
  if (status.status !== 'error') return null
  const retryable = !['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE', 'SIZE_OVERFLOW'].includes(
    status.code
  )
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p
        role="alert"
        className={`text-sm ${status.code === 'COMPARISON_SCAN_ACTIVE' ? 'text-warning' : 'text-error'}`}
      >
        {errorMessage(status.code, scanActive)}
      </p>
      {retryable && (
        <Button variant="secondary" disabled={scanActive} onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  )
}

function RankedRows({
  rows,
  ranking,
  pair,
  onOpen,
  onScope,
  focus
}: {
  rows: readonly ComparisonDirectoryChange[]
  ranking: Ranking
  pair: ComparisonPair
  onOpen: OpenComparisonEntry
  onScope: ScopeChange
  focus: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const sign = ranking === 'growth' ? 1 : -1
  const ranked = rows
    .filter(
      ({ observedDeltaBytes: delta, relativePath }) =>
        relativePath !== '' && delta !== null && delta * sign > 0
    )
    .slice(0, rankingLimit)
  if (!ranked.length)
    return (
      <p className="text-sm text-text-secondary">
        No directories with known {ranking === 'growth' ? 'growth' : 'reduction'} in this scope.
      </p>
    )
  const maximum = Math.abs(ranked[0].observedDeltaBytes!)
  return (
    <ol className="divide-y divide-separator">
      {ranked.map((row) => (
        <li key={row.relativePath} className="flex min-w-0 items-center gap-2 py-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-sm">
              <ChangePath path={row.relativePath} />
              <span className="tabular-nums">
                <ComparisonBytes value={row.observedDeltaBytes} signed />
              </span>
            </div>
            <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-separator">
              <div
                className={`h-full rounded-full ${ranking === 'growth' ? 'bg-[#a5b4fc]' : 'bg-[#8bc9d5]'}`}
                style={{ width: `${(Math.abs(row.observedDeltaBytes!) / maximum) * 100}%` }}
              />
            </div>
            {row.uncertain && <p className="text-xs text-warning">Uncertain coverage or changes</p>}
          </div>
          <ChangeActions
            row={row}
            pair={pair}
            onOpen={onOpen}
            onScope={onScope}
            fallbackFocus={focus}
          />
        </li>
      ))}
    </ol>
  )
}

export function DetailedChanges({
  selection,
  scanActive,
  onOpen,
  navigation
}: {
  selection: AdoptedComparisonSelection
  scanActive: boolean | undefined
  onOpen: OpenComparisonEntry
  navigation?: ChangeNavigation
}): React.JSX.Element {
  const {
    selectionId,
    compatibility: { pair }
  } = selection
  const [queue] = useState(() => new DetailedQueryQueue())
  const [view, setView] = useState<DetailView>()
  const [files, setFiles] = useState<PageSettings>(startingPage)
  const [directories, setDirectories] = useState<PageSettings>(startingPage)
  const [scope, setScope] = useState('')
  const [includeRoot, setIncludeRoot] = useState(false)
  const [rankings, setRankings] = useState<Partial<Record<Ranking, boolean>>>({})
  const heading = useRef<HTMLHeadingElement>(null)
  const tabs = useRef<Partial<Record<DetailView, HTMLButtonElement | null>>>({})
  const id = useId()

  const fileQuery = useMemo(
    () => ({
      selectionId,
      query: {
        ...pair,
        offset: files.offset,
        limit,
        sort: files.sort,
        ...(files.kind && { kinds: [files.kind] }),
        ...(scope && { relativeDirectory: scope })
      }
    }),
    [files, pair, scope, selectionId]
  )
  const directoryQuery = useMemo(
    () => ({
      selectionId,
      query: {
        ...pair,
        offset: directories.offset,
        limit,
        sort: directories.sort,
        ...(directories.kind && { kinds: [directories.kind] }),
        ...(scope && { relativeDirectory: scope }),
        ...(includeRoot && !scope && { includeRoot: true })
      }
    }),
    [directories, includeRoot, pair, scope, selectionId]
  )
  const rankQueries = useMemo(() => {
    const rank = (
      sort: ComparisonSort
    ): ComparisonReadRequest<ComparisonDirectoryQuery & { offset: number; limit: number }> => ({
      selectionId,
      query: {
        ...pair,
        sort,
        offset: 0,
        limit: rankingLimit,
        ...(scope && { relativeDirectory: scope })
      }
    })
    return { growth: rank(direction.growth), reduction: rank(direction.reduction) }
  }, [pair, scope, selectionId])

  const directoryView = view === 'directories'
  const filePage = useDetailedPage(
    queue,
    fileQuery,
    window.spaceLens.listComparisonFileChanges,
    view === 'files',
    scanActive
  )
  const directoryPage = useDetailedPage(
    queue,
    directoryQuery,
    window.spaceLens.listComparisonDirectoryChanges,
    directoryView,
    scanActive
  )
  const reused = (ranking: Ranking): readonly ComparisonDirectoryChange[] | undefined =>
    !directories.kind &&
    directories.offset === 0 &&
    (!includeRoot || !!scope) &&
    directories.sort === direction[ranking]
      ? directoryPage.state.value?.items
      : undefined
  const fromGrowth = reused('growth')
  const fromReduction = reused('reduction')
  const growth = useDetailedPage(
    queue,
    rankQueries.growth,
    window.spaceLens.listComparisonDirectoryChanges,
    directoryView && !!rankings.growth && !fromGrowth,
    scanActive
  )
  const reduction = useDetailedPage(
    queue,
    rankQueries.reduction,
    window.spaceLens.listComparisonDirectoryChanges,
    directoryView && !!rankings.reduction && !fromReduction,
    scanActive
  )
  const current = directoryView ? directoryPage : filePage
  const settings = directoryView ? directories : files
  const setSettings = directoryView ? setDirectories : setFiles
  const page = current.state.value
  const updateScope: ScopeChange = (path, next) => {
    if (path !== scope) {
      setScope(path)
      setFiles((settings) => ({ ...settings, offset: 0 }))
      setDirectories((settings) => ({ ...settings, offset: 0 }))
      setRankings({})
    }
    setView(next)
    tabs.current[next]?.focus({ preventScroll: true })
  }

  return (
    <Card aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
      <h3 ref={heading} tabIndex={-1} id={`${id}-title`} className="text-base font-semibold">
        Detailed Changes
      </h3>
      {navigation && (
        <p
          role={navigation.status === 'error' ? 'alert' : 'status'}
          className={
            navigation.status === 'error' ? 'text-sm text-error' : 'text-sm text-text-secondary'
          }
        >
          {navigation.message}
        </p>
      )}
      <div
        role="tablist"
        aria-label="Detailed change views"
        className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-border bg-background/40 p-1"
      >
        {options.map((option, index) => (
          <button
            key={option}
            type="button"
            role="tab"
            ref={(element) => {
              tabs.current[option] = element
            }}
            id={`${id}-${option}-tab`}
            aria-selected={view === option}
            aria-controls={`${id}-${option}-panel`}
            tabIndex={view === option || (!view && index === 0) ? 0 : -1}
            onClick={() => setView(option)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 'files'
                  : event.key === 'End'
                    ? 'directories'
                    : options[1 - index]
              tabs.current[next]?.focus()
            }}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-hover aria-selected:bg-surface-elevated aria-selected:text-text-primary"
          >
            {views[option]}
          </button>
        ))}
      </div>
      {!view && (
        <p className="text-sm text-text-secondary">
          Choose File Changes or Directory Changes to load details.
        </p>
      )}
      {options.map((option) => (
        <div
          key={option}
          role="tabpanel"
          id={`${id}-${option}-panel`}
          aria-labelledby={`${id}-${option}-tab`}
          hidden={option !== view}
          className="min-w-0 space-y-3"
        >
          {option === view && (
            <>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-separator pb-2">
                <div className="min-w-0 text-sm">
                  <p className="text-xs text-text-secondary">Scope</p>
                  <ChangePath path={scope} />
                </div>
                {scope && (
                  <Button variant="secondary" onClick={() => updateScope('', view)}>
                    Return to root
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                  {directoryView ? 'Directory status' : 'File classification'}
                  <select
                    className="min-h-9 rounded-md border border-border bg-background px-2 text-text-primary"
                    value={settings.kind}
                    onChange={(event) => {
                      const kind = event.currentTarget.value as PageSettings['kind']
                      setSettings((previous) => ({ ...previous, kind, offset: 0 }))
                    }}
                  >
                    <option value="">{directoryView ? 'All statuses' : 'All records'}</option>
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {fileKinds[kind].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                  Sort
                  <select
                    className="min-h-9 rounded-md border border-border bg-background px-2 text-text-primary"
                    value={settings.sort}
                    onChange={(event) => {
                      const sort = event.currentTarget.value as ComparisonSort
                      setSettings((previous) => ({ ...previous, sort, offset: 0 }))
                    }}
                  >
                    {Object.entries(sorts).map(([sort, label]) => (
                      <option key={sort} value={sort}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {directoryView && !scope && (
                  <label className="flex items-center gap-2 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={includeRoot}
                      onChange={(event) => {
                        setIncludeRoot(event.currentTarget.checked)
                        setDirectories((previous) => ({ ...previous, offset: 0 }))
                      }}
                    />
                    Include comparison root
                  </label>
                )}
                {current.state.status === 'ready' && (
                  <Button variant="secondary" disabled={scanActive} onClick={current.retry}>
                    Refresh results
                  </Button>
                )}
              </div>
              <ReadStatus
                status={current.state}
                label={page ? 'Refreshing results' : 'Loading changes'}
                scanActive={scanActive}
                retry={current.retry}
              />
              <Pagination
                label={directoryView ? 'Directory change pages' : 'File change pages'}
                previousLabel="Previous changes page"
                nextLabel="Next changes page"
                range={page ? range(page) : null}
                previous={
                  page && page.offset > 0 && current.state.status !== 'loading'
                    ? () =>
                        setSettings((prev) => ({
                          ...prev,
                          offset: Math.max(0, page.offset - page.limit)
                        }))
                    : null
                }
                next={
                  page?.nextOffset != null && current.state.status !== 'loading'
                    ? () => setSettings((prev) => ({ ...prev, offset: page.nextOffset! }))
                    : null
                }
              />
              {page?.items.length ? (
                <ChangeTable
                  view={view}
                  rows={page.items}
                  pair={pair}
                  onOpen={onOpen}
                  onScope={updateScope}
                  fallbackFocus={heading}
                />
              ) : null}
              {page && !page.totalCount && (
                <p className="text-sm text-text-secondary">
                  {scope || settings.kind
                    ? 'No matching changes.'
                    : directoryView
                      ? 'No directory records in this scope.'
                      : 'No file records in this comparison.'}
                </p>
              )}
              {directoryView && (
                <div className="space-y-3 border-t border-separator pt-3">
                  <p className="text-xs text-text-secondary">
                    Directory totals include nested files, so parent and child results may overlap.
                    Rankings use the current scope.
                  </p>
                  <div className="grid min-w-0 gap-3 @min-[46rem]:grid-cols-2">
                    {(
                      [
                        { ranking: 'growth', read: growth, reuse: fromGrowth },
                        { ranking: 'reduction', read: reduction, reuse: fromReduction }
                      ] as const
                    ).map(({ ranking, read, reuse }) => (
                      <section
                        key={ranking}
                        aria-label={rankingNames[ranking]}
                        className="min-w-0 space-y-2 rounded-lg border border-separator p-3"
                      >
                        <h4 className="text-sm font-semibold">{rankingNames[ranking]}</h4>
                        {!rankings[ranking] ? (
                          <Button
                            variant="secondary"
                            onClick={() => setRankings({ ...rankings, [ranking]: true })}
                          >
                            {ranking === 'growth'
                              ? 'Load growth ranking'
                              : 'Load reduction ranking'}
                          </Button>
                        ) : (
                          <>
                            {!reuse && (
                              <ReadStatus
                                status={read.state}
                                label="Loading ranking"
                                scanActive={scanActive}
                                retry={read.retry}
                              />
                            )}
                            {(reuse || read.state.value) && (
                              <RankedRows
                                rows={reuse ?? read.state.value!.items}
                                ranking={ranking}
                                pair={pair}
                                onOpen={onOpen}
                                onScope={updateScope}
                                focus={heading}
                              />
                            )}
                          </>
                        )}
                      </section>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </Card>
  )
}
