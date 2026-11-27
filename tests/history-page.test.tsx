import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ScanHistoryItem, ScanHistoryPage } from '../src/shared/history'
import { resolveScanHistoryQuery } from '../src/shared/history'
import type { ScanStateSnapshot, SpaceLensAPI } from '../src/shared/ipc'
import App from '../src/renderer/src/App'
import { HistoryPage } from '../src/renderer/src/pages/HistoryPage'
import { SnapshotSelections } from '../src/renderer/src/features/snapshots/selection'
import { mockSnapshotSelection } from './snapshot-selection-fixture'

function saved(id: number, path = '/storage/archive/' + id, partial = false): ScanHistoryItem {
  const finishedAt = new Date(Date.UTC(2026, 10, 26, 12, id)).toISOString()
  return {
    id: String(id),
    rootPath: path,
    status: 'completed',
    startedAt: finishedAt,
    finishedAt,
    summary: {
      totalBytes: id * 1000,
      fileCount: id,
      directoryCount: 1,
      errorCount: partial ? 12 : 0
    },
    durationMs: id * 1100,
    incomplete: partial,
    isLatest: false
  }
}

const list = vi.fn<SpaceLensAPI['listScanHistory']>()
const listen = vi.fn<SpaceLensAPI['onScanStateChanged']>()
const unlisten = vi.fn()
const listeners = new Set<Parameters<SpaceLensAPI['onScanStateChanged']>[0]>()
const prepare = vi.fn<SpaceLensAPI['prepareSnapshotSelection']>()
const getScanSnapshot = vi.fn<SpaceLensAPI['getScanSnapshot']>()
let rows: ScanHistoryItem[]
let revision: number
let historyRevision: number
let snapshots: SnapshotSelections

function seed(count: number, prefix = '/archive/'): ScanHistoryItem[] {
  return Array.from({ length: count }, (_, index) => saved(count - index, prefix + (count - index)))
}

function pageFrom(items: readonly ScanHistoryItem[]): ScanHistoryPage {
  const latestCompletedScanId = items[0]?.id ?? null
  return {
    items: items.map((item) => ({ ...item, isLatest: item.id === latestCompletedScanId })),
    totalCount: items.length,
    offset: 0,
    limit: 20,
    latestCompletedScanId,
    nextOffset: null
  }
}

beforeEach(() => {
  rows = []
  revision = historyRevision = 0
  listen.mockImplementation((callback) => {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
      unlisten()
    }
  })
  list.mockImplementation(async (raw) => {
    const query = resolveScanHistoryQuery(raw)
    if (!query) throw new Error('Invalid history request')
    const { offset, limit, sort, rootPathContains } = query
    const latestCompletedScanId = rows[0]?.id ?? null
    const matching = rows.filter((row) => row.rootPath.includes(rootPathContains ?? ''))
    if (sort === 'oldest') matching.reverse()
    if (sort === 'size-desc' || sort === 'size-asc') {
      const direction = sort === 'size-desc' ? -1 : 1
      matching.sort((a, b) => direction * (a.summary.totalBytes - b.summary.totalBytes))
    }
    const items = matching
      .slice(offset, offset + limit)
      .map((item) => ({ ...item, isLatest: item.id === latestCompletedScanId }))
    return {
      ok: true,
      value: {
        items,
        offset,
        limit,
        totalCount: matching.length,
        nextOffset: offset + items.length < matching.length ? offset + items.length : null,
        latestCompletedScanId
      }
    }
  })
  const api = {
    ...mockSnapshotSelection(getScanSnapshot),
    prepareSnapshotSelection: prepare,
    getScanSnapshot,
    listScanHistory: list,
    onScanStateChanged: listen,
    getScanState: async () => ({ ok: true, value: { revision: 0, state: null } })
  }
  snapshots = new SnapshotSelections(api)
  vi.stubGlobal('spaceLens', api)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  listeners.clear()
  vi.unstubAllGlobals()
})

function notify({
  changed = true,
  session = null
}: { changed?: boolean; session?: ScanStateSnapshot['state'] } = {}): void {
  revision++
  if (changed) historyRevision++
  const state: ScanStateSnapshot = {
    revision,
    historyRevision,
    state: session,
    publicationStatus: 'ready'
  }
  act(() => listeners.forEach((listener) => listener(state)))
}

function mount(): ReturnType<typeof render> {
  return render(<HistoryPage snapshots={snapshots} />)
}

function filter(text: string): void {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by path' }), {
    target: { value: text }
  })
}

function sort(value: string): void {
  fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value } })
}

function next(): HTMLElement {
  return screen.getByRole('button', { name: 'Next history page' })
}

function previous(): HTMLElement {
  return screen.getByRole('button', { name: 'Previous history page' })
}

test('keeps Overview as startup and opens History from the fourth sidebar item', async () => {
  rows = [saved(1, '/projects')]
  render(<App />)
  const nav = screen.getByRole('navigation', { name: 'Main navigation' })
  expect(
    within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent)
  ).toEqual(['Overview', 'Explorer', 'Insights', 'History'])
  expect(within(nav).getByRole('button', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await screen.findByRole('heading', { name: 'Storage Overview' })
  fireEvent.click(within(nav).getByRole('button', { name: 'History' }))
  expect(within(nav).getByRole('button', { name: 'History' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await screen.findByRole('heading', { name: 'Scan History' })
  await screen.findByRole('table', { name: 'Completed scan snapshots' })
  expect(list).toHaveBeenLastCalledWith({ offset: 0, limit: 20, sort: 'newest' })
  expect(listeners.size).toBe(1)
  expect(prepare).not.toHaveBeenCalled()
})

test('renders repeated roots, long paths, exact metadata, coverage and the authoritative Latest', async () => {
  const deepPath = '/projects/' + 'very-long-directory-'.repeat(13) + 'backup'
  rows = [
    { ...saved(1, '/projects'), finishedAt: '2026-11-26T12:05:01.123Z' },
    { ...saved(3, '/projects', true), finishedAt: '2026-11-26T12:05:01.456Z' },
    saved(0, deepPath)
  ]
  mount()
  const table = await screen.findByRole('table')
  const repeated = within(table)
    .getAllByRole('row')
    .filter((row) => within(row).queryByText('/projects'))
  expect(repeated).toHaveLength(2)
  expect(repeated[0].querySelector('time')).toHaveAttribute('datetime', rows[0].finishedAt)
  expect(repeated[1].querySelector('time')).toHaveAttribute('datetime', rows[1].finishedAt)
  expect(repeated[0].querySelector('time')).toHaveTextContent('12:05:01.123')
  expect(repeated[1].querySelector('time')).toHaveTextContent('12:05:01.456')
  expect(within(repeated[0]).getByText('Latest')).toBeVisible()
  expect(within(repeated[1]).queryByText('Latest')).not.toBeInTheDocument()
  expect(within(repeated[1]).getByText('Partial scan')).toBeVisible()
  expect(within(repeated[1]).getByText('12 errors')).toBeVisible()
  const disclosure = within(table).getByTitle(deepPath)
  expect(disclosure.closest('details')).not.toHaveAttribute('open')
  fireEvent.click(disclosure)
  expect(disclosure.closest('details')).toHaveAttribute('open')
  expect(within(table).getByText('0 B')).toHaveAttribute('title', '0 bytes')
  expect(within(table).getByText('0 ms')).toBeVisible()
  expect(within(table).getAllByText('Complete')).toHaveLength(2)
})

test('debounces literal path filtering and clears it without relabeling matches as global history', async () => {
  rows = [
    saved(5, '/Builds/cache'),
    saved(4, '/Builds/Cache%_ folder'),
    saved(3, '/Builds/CacheX folder')
  ]
  mount()
  await screen.findByText(/Showing 1–3 of 3 scans/)
  filter('Cache')
  filter('Cache%_ ')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  await screen.findByText(/Showing 1–1 of 1 matching scan/)
  expect(list).toHaveBeenCalledTimes(2)
  expect(list).toHaveBeenLastCalledWith({
    offset: 0,
    limit: 20,
    sort: 'newest',
    rootPathContains: 'Cache%_ '
  })
  expect(screen.queryByText('Latest')).not.toBeInTheDocument()
  filter('Cache%_ NO MATCH')
  await screen.findByText('No matching snapshots')
  expect(screen.getByText('0 matching scans')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
  await screen.findByText(/Showing 1–3 of 3 scans/)
  expect(list).toHaveBeenLastCalledWith({ offset: 0, limit: 20, sort: 'newest' })
  expect(screen.getByRole('searchbox')).toHaveFocus()
})

test('pages in both directions without retrieving the full history', async () => {
  rows = seed(45)
  mount()
  await screen.findByText(/Showing 1–20 of 45 scans · Page 1 of 3/)
  expect(previous()).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(next())
  await screen.findByText(/Showing 21–40 of 45 scans · Page 2 of 3/)
  expect(screen.queryByText('Latest')).not.toBeInTheDocument()
  fireEvent.click(next())
  await screen.findByText(/Showing 41–45 of 45 scans · Page 3 of 3/)
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(6)
  expect(next()).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(next())
  expect(list).toHaveBeenCalledTimes(3)
  fireEvent.click(previous())
  await screen.findByText(/Showing 21–40 of 45 scans/)
  expect(list.mock.calls.map(([query]) => [query.offset, query.limit])).toEqual([
    [0, 20],
    [20, 20],
    [40, 20],
    [20, 20]
  ])
})

test('sends each supported sort to storage and resets page position on sort and filter changes', async () => {
  rows = seed(42)
  mount()
  const select = screen.getByRole('combobox', { name: 'Sort' })
  expect(
    within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
  ).toEqual(['Newest first', 'Oldest first', 'Largest size first', 'Smallest size first'])
  await screen.findByText(/Showing 1–20 of 42 scans/)
  fireEvent.click(next())
  await screen.findByText(/Showing 21–40 of 42 scans/)
  for (const order of ['oldest', 'size-desc', 'size-asc', 'newest']) {
    sort(order)
    await screen.findByText(/Showing 1–20 of 42 scans/)
    expect(list).toHaveBeenLastCalledWith({ offset: 0, limit: 20, sort: order })
  }
  fireEvent.click(next())
  await screen.findByText(/Showing 21–40 of 42 scans/)
  filter('/archive/2')
  await screen.findByText(/Showing 1–11 of 11 matching scans/)
  expect(list).toHaveBeenLastCalledWith({
    offset: 0,
    limit: 20,
    sort: 'newest',
    rootPathContains: '/archive/2'
  })
})

test('refreshes on publication, Latest deletion, and history changes with the same Latest', async () => {
  rows = [saved(2, '/latest'), saved(1, '/previous')]
  mount()
  await screen.findByText('/latest')
  rows = [saved(3, '/published'), ...rows]
  notify()
  const published = await screen.findByRole('row', { name: /published/ })
  expect(within(published).getByText('Latest')).toBeVisible()
  rows = rows.slice(1)
  notify()
  await waitFor(() =>
    expect(within(screen.getByRole('row', { name: /latest/ })).getByText('Latest')).toBeVisible()
  )
  expect(screen.queryByText('/published')).not.toBeInTheDocument()
  rows = [rows[0]]
  notify()
  await screen.findByText(/Showing 1–1 of 1 scan/)
  expect(screen.queryByText('/previous')).not.toBeInTheDocument()
  notify({ changed: false })
  expect(list).toHaveBeenCalledTimes(4)
  expect(listen).toHaveBeenCalledOnce()
})

test('moves to the last available page after pruning and preserves sort and literal filter', async () => {
  rows = seed(45, '/keep/')
  mount()
  sort('oldest')
  filter('keep')
  await screen.findByText(/Showing 1–20 of 45 matching scans/)
  fireEvent.click(next())
  await screen.findByText(/Showing 21–40 of 45 matching scans/)
  rows = rows.slice(0, 44)
  notify()
  await screen.findByText(/Showing 21–40 of 44 matching scans/)
  fireEvent.click(next())
  await screen.findByText(/Showing 41–44 of 44 matching scans/)
  rows = rows.slice(0, 22)
  list.mockClear()
  notify()
  await screen.findByText(/Showing 21–22 of 22 matching scans · Page 2 of 2/)
  expect(list.mock.calls.map(([query]) => query)).toEqual([
    { offset: 40, limit: 20, sort: 'oldest', rootPathContains: 'keep' },
    { offset: 20, limit: 20, sort: 'oldest', rootPathContains: 'keep' }
  ])
  expect(screen.getByRole('searchbox')).toHaveValue('keep')
  expect(screen.getByRole('combobox')).toHaveValue('oldest')
})

test('shows loading before an authoritative empty page', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(pending.promise)
  mount()
  expect(screen.getByRole('status')).toHaveTextContent('Loading saved snapshots')
  expect(screen.queryByText('No saved scans yet')).not.toBeInTheDocument()
  await act(async () => pending.resolve({ ok: true, value: pageFrom([]) }))
  expect(screen.getByText('No saved scans yet')).toBeVisible()
  expect(screen.getByText('0 saved scans')).toBeVisible()
  expect(next()).toHaveAttribute('aria-disabled', 'true')
  expect(previous()).toHaveAttribute('aria-disabled', 'true')
})

test('keeps completed rows available during scanner progress', async () => {
  rows = [saved(1, '/complete')]
  mount()
  await screen.findByText('/complete')
  const scan = saved(2, '/running')
  notify({
    changed: false,
    session: {
      session: { ...scan, status: 'running', finishedAt: null },
      progress: {
        scanId: scan.id,
        processedFileCount: 1,
        processedDirectoryCount: 1,
        processedBytes: 1000,
        currentPath: scan.rootPath
      },
      failure: null
    }
  })
  expect(screen.getByText('/complete')).toBeVisible()
  expect(screen.queryByText('/running')).not.toBeInTheDocument()
  expect(list).toHaveBeenCalledOnce()
  expect(screen.getByRole('searchbox')).toBeEnabled()
})

test('keeps same-query rows on a failed refresh and retries without exposing storage diagnostics', async () => {
  list.mockRejectedValueOnce(new Error('private SQLite message'))
  rows = [saved(2, '/stable')]
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent('Scan history could not be loaded.')
  expect(screen.queryByText('No saved scans yet')).not.toBeInTheDocument()
  expect(screen.queryByText(/private SQLite/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('/stable')
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(pending.promise)
  notify()
  expect(await screen.findByRole('status')).toHaveTextContent('Refreshing saved snapshots')
  expect(screen.getByText('/stable')).toBeVisible()
  await act(async () =>
    pending.resolve({ ok: false, error: { code: 'UNAVAILABLE', message: 'private failure' } })
  )
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Saved scan storage is unavailable. Showing the last loaded page.'
  )
  expect(screen.getByText('/stable')).toBeVisible()
  rows = [saved(3, '/recovered')]
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('/recovered')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('coalesces history revisions during an outstanding request and skips the stale result', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(pending.promise)
  mount()
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  rows = [saved(3, '/current')]
  notify()
  notify()
  expect(list).toHaveBeenCalledOnce()
  await act(async () => pending.resolve({ ok: true, value: pageFrom([saved(2, '/stale')]) }))
  await screen.findByText('/current')
  expect(screen.queryByText('/stale')).not.toBeInTheDocument()
  expect(list).toHaveBeenCalledTimes(2)
})

test('ignores an older query response after changing sort and filter during loading', async () => {
  rows = [saved(3, '/current')]
  const initial = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(initial.promise)
  mount()
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  const changedSort = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(changedSort.promise)
  sort('oldest')
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  filter('current')
  await screen.findByText('/current')
  await act(async () => {
    initial.resolve({ ok: true, value: pageFrom([saved(2, '/stale-initial')]) })
    changedSort.resolve({ ok: true, value: pageFrom([saved(1, '/stale-sort')]) })
  })
  expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
  expect(screen.getByText('/current')).toBeVisible()
})

test('ignores a pending refresh of the previous page after pagination', async () => {
  rows = seed(24)
  mount()
  await screen.findByText(/Showing 1–20 of 24 scans/)
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(pending.promise)
  notify()
  await screen.findByText('Refreshing saved snapshots…')
  fireEvent.click(next())
  await screen.findByText(/Showing 21–24 of 24 scans/)
  await act(async () => pending.resolve({ ok: true, value: pageFrom([saved(2, '/stale-page')]) }))
  expect(screen.queryByText('/stale-page')).not.toBeInTheDocument()
  expect(screen.getByText(/Showing 21–24 of 24 scans/)).toBeVisible()
})

test('unsubscribes on unmount and ignores a response from an earlier visit', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(pending.promise)
  const old = mount()
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  old.unmount()
  expect(unlisten).toHaveBeenCalledOnce()
  notify()
  expect(list).toHaveBeenCalledOnce()
  rows = [saved(3, '/reopened')]
  mount()
  await screen.findByText('/reopened')
  await act(async () => pending.resolve({ ok: true, value: pageFrom([saved(2, '/old-visit')]) }))
  expect(screen.queryByText('/old-visit')).not.toBeInTheDocument()
  expect(listeners.size).toBe(1)
  expect(prepare).not.toHaveBeenCalled()
})
