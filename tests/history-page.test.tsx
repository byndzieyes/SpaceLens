import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
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
const removeSnapshot = vi.fn<SpaceLensAPI['deleteSnapshot']>()
const getRetention = vi.fn<SpaceLensAPI['getRetentionSettings']>()
const setRetention = vi.fn<SpaceLensAPI['setRetentionSettings']>()
let rows: ScanHistoryItem[]
let revision: number
let historyRevision: number
let snapshots: SnapshotSelections

// jsdom renders the dialog element. Native top-layer focus and Escape are verified in Electron.
beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.setAttribute('open', '')
      }
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.removeAttribute('open')
      }
    }
  })
})
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

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
  let limit = 10
  getRetention.mockImplementation(async () => ({
    ok: true,
    value: { maxCompletedSnapshots: limit }
  }))
  setRetention.mockImplementation(async (value) => {
    limit = value.maxCompletedSnapshots
    return { ok: true, value }
  })
  removeSnapshot.mockImplementation(async ({ scanId }) => {
    if (!rows.some((row) => row.id === scanId))
      return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Missing fixture.' } }
    rows = rows.filter((row) => row.id !== scanId)
    queueMicrotask(() => notify())
    return { ok: true, value: { scanId, latestCompletedScanId: rows[0]?.id ?? null } }
  })
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
    deleteSnapshot: removeSnapshot,
    getRetentionSettings: getRetention,
    setRetentionSettings: setRetention,
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
  return render(<HistoryPage snapshots={snapshots} onOpenSnapshot={vi.fn()} />)
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

function actionsFor(path: string): HTMLElement {
  const row = screen.getByRole('row', { name: new RegExp(path) })
  return within(row).getByRole('button', { name: /Actions for/ })
}

function deleteFrom(path: string): HTMLElement {
  fireEvent.click(actionsFor(path))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete snapshot' }))
  return screen.getByRole('dialog', { name: 'Delete snapshot?' })
}

async function openSettings(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'History Settings' }))
  const dialog = screen.getByRole('dialog', { name: 'History Settings' })
  await within(dialog).findByRole('textbox', { name: 'Maximum retained snapshots' })
  return dialog
}

function editLimit(draft: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Maximum retained snapshots' }), {
    target: { value: draft }
  })
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

test('keeps the row menu outside the scroll region and supports keyboard dismissal and focus return', async () => {
  rows = [saved(1, '/archive')]
  mount()
  await screen.findByText('/archive')
  const trigger = actionsFor('/archive')
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const menu = screen.getByRole('menu', { name: 'Snapshot actions' })
  const [explorer, insights, deletion] = within(menu).getAllByRole('menuitem')
  expect(screen.getByRole('region', { name: 'Saved snapshots table' })).not.toContainElement(menu)
  expect(explorer).toHaveTextContent('Open in Explorer')
  expect(explorer).toHaveFocus()
  fireEvent.keyDown(explorer, { key: 'ArrowDown' })
  expect(insights).toHaveFocus()
  fireEvent.keyDown(insights, { key: 'End' })
  expect(deletion).toHaveFocus()
  fireEvent.keyDown(deletion, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

test('keeps the open menu tied to its snapshot when a revision moves the row', async () => {
  rows = [saved(2, '/target'), saved(1, '/earlier')]
  mount()
  await screen.findByText('/target')
  fireEvent.click(actionsFor('/target'))
  const explorer = screen.getByRole('menuitem', { name: 'Open in Explorer' })
  rows = [saved(3, '/newLatest'), ...rows]
  notify()
  await screen.findByText('/newLatest')
  expect(explorer).toHaveFocus()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete snapshot' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete snapshot?' })
  expect(within(dialog).getByText('/target')).toBeVisible()
  expect(within(dialog).queryByText('Latest')).not.toBeInTheDocument()
})

test('cancels deletion by button and Escape and identifies the exact Latest target', async () => {
  rows = [saved(3, '/latest'), saved(1, '/archive')]
  mount()
  await screen.findByText('/latest')
  const dialog = deleteFrom('/latest')
  const confirmation = within(dialog)
  expect(confirmation.getByText('/latest')).toBeVisible()
  expect(confirmation.getByText('3 KB')).toBeVisible()
  expect(confirmation.getByText('Latest')).toBeVisible()
  expect(confirmation.getByText(/previous retained publication will become Latest/)).toBeVisible()
  expect(confirmation.getByText(/actual files and folders will not be deleted/)).toBeVisible()
  expect(confirmation.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  fireEvent.click(confirmation.getByRole('button', { name: 'Cancel' }))
  expect(actionsFor('/latest')).toHaveFocus()
  fireEvent(deleteFrom('/archive'), new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(actionsFor('/archive')).toHaveFocus()
  expect(removeSnapshot).not.toHaveBeenCalled()
})

test('a revision during confirmation preserves the target, and a successful deletion refreshes once', async () => {
  rows = [saved(2, '/target'), saved(1, '/previous')]
  mount()
  await screen.findByText('/target')
  const dialog = deleteFrom('/target')
  rows = [saved(3, '/newLatest'), ...rows]
  notify()
  await screen.findByText('/newLatest')
  expect(within(dialog).queryByText('Latest')).not.toBeInTheDocument()
  list.mockClear()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete snapshot' }))
  await screen.findByText('Saved snapshot deleted.')
  await waitFor(() => expect(screen.queryByText('/target')).not.toBeInTheDocument())
  expect(removeSnapshot).toHaveBeenCalledExactlyOnceWith({ scanId: '2' })
  expect(list).toHaveBeenCalledTimes(1)
  expect(within(screen.getByRole('row', { name: /newLatest/ })).getByText('Latest')).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Scan History' })).toHaveFocus()
})

test('uses authoritative Latest fallback after deletion and shows the empty state for the final snapshot', async () => {
  rows = [saved(2, '/latest'), saved(1, '/fallback')]
  mount()
  await screen.findByText('/latest')
  fireEvent.click(within(deleteFrom('/latest')).getByRole('button', { name: 'Delete snapshot' }))
  await waitFor(() =>
    expect(within(screen.getByRole('row', { name: /fallback/ })).getByText('Latest')).toBeVisible()
  )
  fireEvent.click(within(deleteFrom('/fallback')).getByRole('button', { name: 'Delete snapshot' }))
  await screen.findByText('No saved scans yet')
  expect(screen.queryByText('Latest')).not.toBeInTheDocument()
  expect(removeSnapshot.mock.calls).toEqual([[{ scanId: '2' }], [{ scanId: '1' }]])
})

test.each([
  ['SNAPSHOT_IN_USE', /currently in use/],
  ['SNAPSHOT_EXPIRED', /already been removed/],
  ['SNAPSHOT_UNAVAILABLE', /unavailable for deletion/],
  ['UNAVAILABLE', /storage is busy or unavailable/],
  ['SNAPSHOT_DELETE_UNCERTAIN', /Deletion could not be confirmed/]
] as const)('handles deletion failure %s without automatically retrying', async (code, text) => {
  rows = [saved(1, '/target')]
  if (code === 'SNAPSHOT_EXPIRED') {
    removeSnapshot.mockImplementationOnce(async () => {
      rows = []
      return { ok: false, error: { code, message: 'private SQLite details' } }
    })
  } else {
    removeSnapshot.mockResolvedValueOnce({
      ok: false,
      error: { code, message: 'private SQLite details' }
    })
  }
  mount()
  await screen.findByText('/target')
  const dialog = deleteFrom('/target')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete snapshot' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(text)
  expect(dialog).not.toHaveTextContent('private SQLite details')
  if (code === 'SNAPSHOT_EXPIRED') await screen.findByText('No saved scans yet')
  if (code === 'SNAPSHOT_EXPIRED' || code === 'SNAPSHOT_DELETE_UNCERTAIN')
    expect(within(dialog).getByRole('button', { name: 'Delete snapshot' })).toBeDisabled()
  expect(removeSnapshot).toHaveBeenCalledOnce()
})

test('prevents duplicate deletion while pending and ignores settlement after unmount', async () => {
  rows = [saved(1, '/target')]
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['deleteSnapshot']>>>()
  removeSnapshot.mockReturnValueOnce(pending.promise)
  const view = mount()
  await screen.findByText('/target')
  const dialog = deleteFrom('/target')
  const button = within(dialog).getByRole('button', { name: 'Delete snapshot' })
  fireEvent.click(button)
  fireEvent.click(button)
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(within(dialog).getByRole('button', { name: 'Deleting snapshot…' })).toBeDisabled()
  expect(removeSnapshot).toHaveBeenCalledOnce()
  view.unmount()
  rows = []
  await act(async () =>
    pending.resolve({ ok: true, value: { scanId: '1', latestCompletedScanId: null } })
  )
  mount()
  await screen.findByText('No saved scans yet')
  expect(screen.queryByText('Saved snapshot deleted.')).not.toBeInTheDocument()
})

test('recovers a last page after deleting its only row while retaining filter and sort', async () => {
  rows = seed(21, '/filtered/')
  mount()
  await screen.findByText(/Showing 1–20 of 21 scans/)
  sort('oldest')
  filter('filtered')
  await screen.findByText(/Showing 1–20 of 21 matching scans/)
  fireEvent.click(next())
  await screen.findByText(/Showing 21–21 of 21 matching scans/)
  fireEvent.click(
    within(deleteFrom('/filtered/21')).getByRole('button', { name: 'Delete snapshot' })
  )
  await screen.findByText(/Showing 1–20 of 20 matching scans/)
  expect(screen.getByRole('combobox')).toHaveValue('oldest')
  expect(screen.getByRole('searchbox')).toHaveValue('filtered')
  expect(previous()).toHaveAttribute('aria-disabled', 'true')
})

test('loads the authoritative setting and validates the safe-integer boundary before saving an increase', async () => {
  mount()
  const dialog = await openSettings()
  const save = within(dialog).getByRole('button', { name: 'Save changes' })
  expect(within(dialog).getByRole('textbox')).toHaveValue('10')
  expect(save).toBeDisabled()
  for (const input of ['', '0', '-1', '2.5', 'wrong', '1e3', '9007199254740992']) {
    editLimit(input)
    expect(within(dialog).getByRole('textbox')).toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeDisabled()
  }
  expect(setRetention).not.toHaveBeenCalled()
  editLimit('9007199254740991')
  expect(save).toBeEnabled()
  fireEvent.click(save)
  await within(dialog).findByText('History retention limit saved.')
  expect(setRetention).toHaveBeenCalledExactlyOnceWith({
    maxCompletedSnapshots: Number.MAX_SAFE_INTEGER
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.getByRole('button', { name: 'History Settings' })).toHaveFocus()
  const reopened = await openSettings()
  expect(within(reopened).getByRole('textbox')).toHaveValue('9007199254740991')
})

test('handles loading failure and explicitly repairs invalid persisted settings', async () => {
  getRetention.mockRejectedValueOnce(new Error('private settings path')).mockResolvedValueOnce({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'invalid private config' }
  })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'History Settings' }))
  expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
    'Retention settings are unavailable.'
  )
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }))
  expect(
    await within(screen.getByRole('dialog')).findByText(/Save a valid limit to resume pruning/)
  ).toBeVisible()
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(setRetention).not.toHaveBeenCalled()
  editLimit('14')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(screen.getByRole('dialog', { name: 'Apply retention limit?' })).toBeVisible()
  expect(setRetention).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Apply limit' }))
  await screen.findByText('Saved limit 14')
  expect(setRetention).toHaveBeenCalledExactlyOnceWith({ maxCompletedSnapshots: 14 })
})

test('confirms a reduction and uses the global retained count through deferred pruning', async () => {
  rows = seed(23)
  mount()
  await screen.findByText(/Showing 1–20 of 23 scans/)
  filter('/archive/23')
  await screen.findByText(/Showing 1–1 of 1 matching scan/)
  const settings = await openSettings()
  expect(within(settings).getByText('Retained snapshots 23')).toBeVisible()
  editLimit('1')
  fireEvent.click(within(settings).getByRole('button', { name: 'Save changes' }))
  const confirmation = screen.getByRole('dialog', { name: 'Reduce retention limit?' })
  expect(
    within(confirmation).getByText(/Latest and protected snapshots are excluded/)
  ).toBeVisible()
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Back' }))
  expect(setRetention).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('1')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reduce limit' }))
  await screen.findByText('Saved limit 1')
  expect(screen.getByText(/Some snapshots may be retained temporarily/)).toBeVisible()
  expect(removeSnapshot).not.toHaveBeenCalled()
  rows = [rows[0], rows.at(-1)!]
  notify()
  await screen.findByText('Retained snapshots 2')
  expect(list).toHaveBeenCalledWith({ limit: 1 })
  rows = [rows[0]]
  notify()
  await screen.findByText('Retained snapshots 1')
  expect(screen.queryByText(/Some snapshots may be retained temporarily/)).not.toBeInTheDocument()
  expect(screen.getByRole('searchbox')).toHaveValue('/archive/23')
})

test('preserves a draft after save failure and prevents duplicate saves if settings closes while pending', async () => {
  setRetention.mockResolvedValueOnce({
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'private path' }
  })
  mount()
  await openSettings()
  editLimit('19')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
    /could not be saved/
  )
  expect(screen.getByRole('textbox')).toHaveValue('19')
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['setRetentionSettings']>>>()
  setRetention.mockReturnValueOnce(pending.promise)
  const save = screen.getByRole('button', { name: 'Save changes' })
  fireEvent.click(save)
  fireEvent.click(save)
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  const reopened = await openSettings()
  expect(within(reopened).getByRole('textbox')).toHaveValue('19')
  expect(getRetention).toHaveBeenCalledOnce()
  expect(setRetention).toHaveBeenCalledTimes(2)
  await act(async () => pending.resolve({ ok: true, value: { maxCompletedSnapshots: 20 } }))
  expect(within(reopened).getByRole('textbox')).toHaveValue('20')
  expect(within(reopened).getByText('Saved limit 20')).toBeVisible()
})
