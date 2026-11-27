import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type {
  ComparisonCompatibility,
  ComparisonPair,
  CompatiblePair
} from '../src/shared/comparison'
import { resolveScanHistoryQuery, type ScanHistoryItem } from '../src/shared/history'
import type { ScanStateSnapshot, SpaceLensAPI } from '../src/shared/ipc'
import App from '../src/renderer/src/App'
import { mockSnapshotSelection } from './snapshot-selection-fixture'

function saved(id: number, rootPath = '/photos', incomplete = false): ScanHistoryItem {
  // The fixtures are supplied in publication order, independently of wall-clock ordering.
  const date = new Date(Date.UTC(2026, 10, 25, 0, 100 - id)).toISOString()
  return {
    id: String(id),
    rootPath,
    status: 'completed',
    startedAt: date,
    finishedAt: date,
    durationMs: 0,
    summary: {
      totalBytes: 1000 * id,
      fileCount: id,
      directoryCount: 1,
      errorCount: Number(incomplete)
    },
    isLatest: false,
    incomplete
  }
}

const list = vi.fn<SpaceLensAPI['listScanHistory']>()
const metadata = vi.fn<SpaceLensAPI['getScanHistoryMetadata']>()
const evaluate = vi.fn<SpaceLensAPI['evaluateComparisonCompatibility']>()
const prepare = vi.fn<SpaceLensAPI['prepareComparisonSelection']>()
const adopt = vi.fn<SpaceLensAPI['adoptComparisonSelection']>()
const discard = vi.fn<SpaceLensAPI['discardPreparedComparisonSelection']>()
const release = vi.fn<SpaceLensAPI['releaseComparisonSelection']>()
const summary = vi.fn<SpaceLensAPI['getComparisonSummary']>()
const fileChanges = vi.fn<SpaceLensAPI['listComparisonFileChanges']>()
const directoryChanges = vi.fn<SpaceLensAPI['listComparisonDirectoryChanges']>()
const listen = new Set<Parameters<SpaceLensAPI['onScanStateChanged']>[0]>()
const readSnapshot = vi.fn<SpaceLensAPI['getScanSnapshot']>()
let rows: ScanHistoryItem[]
let scanner: ScanStateSnapshot
let tickets: Map<string, CompatiblePair>
let ticketNumber: number

function pair(baseline: number, target: number): ComparisonPair {
  return { baselineScanId: String(baseline), targetScanId: String(target) }
}

function compatibility(pair: ComparisonPair): ComparisonCompatibility {
  const baseline = rows.find(({ id }) => id === pair.baselineScanId)
  const target = rows.find(({ id }) => id === pair.targetScanId)
  if (pair.baselineScanId === pair.targetScanId)
    return { pair, status: 'incompatible', reason: { code: 'SAME_SNAPSHOT' } }
  if (!baseline || !target)
    return {
      pair,
      status: 'incompatible',
      reason: { code: 'SNAPSHOT_EXPIRED', side: baseline ? 'target' : 'baseline' }
    }
  if (baseline.rootPath !== target.rootPath)
    return { pair, status: 'incompatible', reason: { code: 'DIFFERENT_ROOTS' } }
  const common = {
    pair,
    normalizedRoot: baseline.rootPath,
    pathStyle: 'posix',
    coverage: {
      baseline: baseline.incomplete ? 'incomplete' : 'complete',
      target: target.incomplete ? 'incomplete' : 'complete'
    }
  } as const
  if (baseline.incomplete || target.incomplete)
    return {
      ...common,
      status: 'compatible-with-warnings',
      warnings: [{ code: 'INCOMPLETE_COVERAGE', side: baseline.incomplete ? 'baseline' : 'target' }]
    }
  return { ...common, status: 'compatible' }
}

function scanState(active: boolean, changed = false): void {
  const scan = saved(99)
  scanner = {
    revision: scanner.revision + 1,
    historyRevision: (scanner.historyRevision ?? 0) + Number(changed),
    state: active
      ? {
          session: { ...scan, status: 'running', finishedAt: null },
          progress: {
            scanId: scan.id,
            processedFileCount: 0,
            processedDirectoryCount: 0,
            processedBytes: 0,
            currentPath: null
          },
          failure: null
        }
      : null
  }
  act(() => listen.forEach((listener) => listener(scanner)))
}

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
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})

afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

beforeEach(() => {
  vi.resetAllMocks()
  rows = [saved(2), saved(1)]
  scanner = { revision: 0, historyRevision: 0, state: null }
  tickets = new Map()
  ticketNumber = 0
  readSnapshot.mockResolvedValue({ ok: true, value: { snapshot: null, unavailable: null } })
  list.mockImplementation(async (raw) => {
    const query = resolveScanHistoryQuery(raw)!
    const matched = rows.filter((scan) => scan.rootPath.includes(query.rootPathContains ?? ''))
    if (query.sort === 'oldest') matched.reverse()
    const { limit, offset } = query
    return {
      ok: true,
      value: {
        items: matched
          .slice(offset, offset + limit)
          .map((scan) => ({ ...scan, isLatest: scan.id === rows[0]?.id })),
        limit,
        offset,
        totalCount: matched.length,
        nextOffset: offset + limit < matched.length ? offset + limit : null,
        latestCompletedScanId: rows[0]?.id ?? null
      }
    }
  })
  metadata.mockImplementation(async ({ scanId }) => {
    const scan = rows.find((item) => item.id === scanId)
    return scan
      ? { ok: true, value: { ...scan, isLatest: scanId === rows[0]?.id } }
      : { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Private fixture path.' } }
  })
  evaluate.mockImplementation(async (pair) => ({ ok: true, value: compatibility(pair) }))
  prepare.mockImplementation(async (pair) => {
    const result = compatibility(pair)
    if (result.status === 'incompatible')
      return {
        ok: false,
        error: { code: 'INCOMPATIBLE_SNAPSHOTS', message: 'Private fixture path.' }
      }
    const ticket = String(++ticketNumber)
    tickets.set(ticket, result)
    return { ok: true, value: { ticket, compatibility: result } }
  })
  adopt.mockImplementation(async ({ ticket }) => ({
    ok: true,
    value: { selectionId: 'adopted-' + ticket, compatibility: tickets.get(ticket)! }
  }))
  discard.mockResolvedValue({ ok: true, value: null })
  release.mockResolvedValue({ ok: true, value: null })
  const api = {
    ...mockSnapshotSelection(readSnapshot),
    getScanSnapshot: readSnapshot,
    getScanState: async () => ({ ok: true, value: scanner }),
    onScanStateChanged: (callback: Parameters<SpaceLensAPI['onScanStateChanged']>[0]) => {
      listen.add(callback)
      return () => listen.delete(callback)
    },
    listScanHistory: list,
    getScanHistoryMetadata: metadata,
    evaluateComparisonCompatibility: evaluate,
    prepareComparisonSelection: prepare,
    adoptComparisonSelection: adopt,
    discardPreparedComparisonSelection: discard,
    releaseComparisonSelection: release,
    getComparisonSummary: summary,
    listComparisonFileChanges: fileChanges,
    listComparisonDirectoryChanges: directoryChanges
  }
  vi.stubGlobal('spaceLens', api)
})

afterEach(async () => {
  await act(async () => cleanup())
  expect(listen.size).toBe(0)
  expect(summary).not.toHaveBeenCalled()
  expect(fileChanges).not.toHaveBeenCalled()
  expect(directoryChanges).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

const click = (element: HTMLElement): void => {
  fireEvent.click(element)
}
const nav = (name: string): void =>
  click(
    within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', {
      name
    })
  )
const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })
const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })
const active = (): HTMLElement => screen.getByRole('region', { name: 'Active comparison' })
const side = (name: string): HTMLElement => screen.getByRole('region', { name })
const date = (id: number): string => saved(id).finishedAt
const hasScan = (scope: HTMLElement, id: number): void => {
  expect(scope.querySelector(`time[datetime="${date(id)}"]`)).toBeInTheDocument()
}
const openComparison = (): ReturnType<typeof render> => {
  const view = render(<App />)
  nav('History')
  click(tab('Comparison'))
  return view
}
const compatible = async (): Promise<void> => {
  await waitFor(() => expect(button('Compare snapshots')).toBeEnabled())
}

async function choose(which: 'baseline' | 'target', id: number): Promise<void> {
  click(button(`Choose ${which} snapshot`))
  const dialog = screen.getByRole('dialog', { name: `Choose ${which} snapshot` })
  await waitFor(() =>
    expect(dialog.querySelector(`time[datetime="${date(id)}"]`)).toBeInTheDocument()
  )
  click(dialog.querySelector(`time[datetime="${date(id)}"]`)!.closest('button')!)
}

async function compare(id = 1): Promise<void> {
  await compatible()
  click(button('Compare snapshots'))
  await screen.findByRole('region', { name: 'Active comparison' })
  expect(adopt).toHaveBeenLastCalledWith({ ticket: String(id) })
}

test('keeps Comparison inside History and preserves Scans filter, sort and page across keyboard tab changes', async () => {
  rows = Array.from({ length: 24 }, (_, index) => saved(24 - index, '/photos/' + (24 - index)))
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Storage Overview' })).toBeVisible()
  expect(
    within(screen.getByRole('navigation', { name: 'Main navigation' })).queryByRole('button', {
      name: 'Comparison'
    })
  ).toBeNull()
  nav('History')
  expect(tab('Scans')).toHaveAttribute('aria-selected', 'true')
  expect(button('History Settings')).toBeVisible()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by path' }), {
    target: { value: '/photos' }
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'oldest' } })
  await screen.findByText(/Showing 1–20/)
  click(button('Next history page'))
  await screen.findByText(/Showing 21–24/)
  tab('Scans').focus()
  fireEvent.keyDown(tab('Scans'), { key: 'ArrowRight' })
  expect(tab('Comparison')).toHaveFocus()
  click(tab('Comparison'))
  expect(screen.getByRole('tabpanel', { name: 'Comparison' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'History Settings' })).toBeNull()
  fireEvent.keyDown(tab('Comparison'), { key: 'Home' })
  expect(tab('Scans')).toHaveFocus()
  list.mockClear()
  click(tab('Scans'))
  await screen.findByText(/Showing 21–24/)
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith({
      offset: 20,
      limit: 20,
      sort: 'oldest',
      rootPathContains: '/photos'
    })
  )
  expect(screen.getByRole('searchbox', { name: 'Filter by path' })).toHaveValue('/photos')
  expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('oldest')
})

test.each([0, 1])('explains insufficient history with %i retained snapshots', async (n) => {
  rows = rows.slice(0, n)
  openComparison()
  expect(await screen.findByText(n ? /One saved snapshot/ : /Save two snapshots/)).toBeVisible()
  if (n) await waitFor(() => hasScan(side('Target'), 2))
  expect(button('Compare snapshots')).toBeDisabled()
  expect(evaluate).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})

test('suggests the recent compatible direction by publication order and defers adoption until clicked', async () => {
  rows = [saved(3, '/work'), saved(2, '/photo'), saved(1, '/photo')]
  openComparison()
  await compatible()
  hasScan(side('Baseline'), 1)
  hasScan(side('Target'), 2)
  expect(evaluate).toHaveBeenCalledExactlyOnceWith(pair(1, 2))
  expect(prepare).not.toHaveBeenCalled()
  await compare()
  expect(prepare).toHaveBeenCalledExactlyOnceWith(pair(1, 2))
})

test('leaves a selector open to choose when recent roots differ and distinguishes same-ID and incompatible choices', async () => {
  rows = [saved(3, '/work'), saved(2), saved(1, '/archive')]
  openComparison()
  await waitFor(() => expect(side('Baseline').querySelector('time')).toBeNull())
  await screen.findByText('Choose a baseline snapshot.')
  await waitFor(() => expect(evaluate).toHaveBeenCalledExactlyOnceWith(pair(2, 3)))
  await choose('baseline', 3)
  expect(await screen.findByText('Choose two different snapshots.')).toBeVisible()
  expect(evaluate).toHaveBeenCalledTimes(1)
  await choose('baseline', 1)
  expect(
    await screen.findByText('These snapshots were scanned from different roots.')
  ).toBeVisible()
  expect(button('Compare snapshots')).toBeDisabled()
})

test('uses paged metadata beyond the first page and honors literal path filtering', async () => {
  const long = '/deep/' + 'one more directory segment/'.repeat(38)
  rows = Array.from({ length: 23 }, (_, index) =>
    saved(23 - index, index < 2 ? '/photos' : long + index, index === 22)
  )
  openComparison()
  await compatible()
  click(button('Choose baseline snapshot'))
  const dialog = screen.getByRole('dialog', { name: 'Choose baseline snapshot' })
  click(within(dialog).getByRole('button', { name: 'Next snapshots' }))
  await waitFor(() =>
    expect(dialog.querySelector(`time[datetime="${date(1)}"]`)).toBeInTheDocument()
  )
  expect(within(dialog).getByText('Partial scan')).toBeVisible()
  expect(list).toHaveBeenCalledWith({ limit: 20, offset: 20 })
  const filter = within(dialog).getByRole('searchbox', { name: 'Filter by path' })
  fireEvent.change(filter, { target: { value: long + '22' } })
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith({ limit: 20, offset: 0, rootPathContains: long + '22' })
  )
  await waitFor(() => expect(dialog.querySelectorAll('li')).toHaveLength(1))
  click(dialog.querySelector('li button')!)
  await waitFor(() => expect(metadata).toHaveBeenCalledWith({ scanId: '1' }))
  hasScan(side('Baseline'), 1)
  expect(within(side('Baseline')).getByText('Partial scan')).toBeVisible()
  expect(within(side('Target')).getByText('Latest')).toBeVisible()
})

test('adopts an explicit reverse pair with coverage warnings while draft swaps keep the active pair fixed', async () => {
  rows = [saved(2), saved(1, '/photos', true)]
  openComparison()
  await compare()
  expect(within(active()).getByText(/Baseline has partial coverage/)).toBeVisible()
  click(button('Swap baseline and target'))
  await compatible()
  hasScan(side('Baseline'), 2)
  expect(within(active()).getByText(/Baseline has partial coverage/)).toBeVisible()
  expect(prepare).toHaveBeenCalledTimes(1)
  click(button('Compare snapshots'))
  expect(await within(active()).findByText(/Target has partial coverage/)).toBeVisible()
  expect(prepare).toHaveBeenLastCalledWith(pair(2, 1))
  click(button('Clear comparison'))
  await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith({ selectionId: 'adopted-2' }))
  expect(screen.queryByRole('region', { name: 'Active comparison' })).toBeNull()
})

test('opens an exact History row as a draft and revalidates it when returning from Scans', async () => {
  rows = [saved(3), saved(2), saved(1)]
  render(<App />)
  nav('History')
  const history = await screen.findByRole('table', { name: 'Completed scan snapshots' })
  const row = history.querySelector(`time[datetime="${date(1)}"]`)!.closest('tr')!
  click(within(row).getByRole('button', { name: /^Actions for/ }))
  click(screen.getByRole('menuitem', { name: 'Compare snapshot' }))
  expect(tab('Comparison')).toHaveFocus()
  hasScan(side('Baseline'), 1)
  expect(evaluate).not.toHaveBeenCalled()
  await choose('target', 3)
  await compare()
  click(tab('Scans'))
  await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith({ selectionId: 'adopted-1' }))
  click(tab('Comparison'))
  await compatible()
  expect(evaluate).toHaveBeenCalledTimes(2)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('region', { name: 'Active comparison' })).toBeNull()
})

test.each(['scanner event', 'typed admission'] as const)(
  'stops automatic checks after %s and retries only on request',
  async (source) => {
    if (source === 'scanner event') scanState(true)
    else
      evaluate.mockResolvedValueOnce({
        ok: false,
        error: { code: 'COMPARISON_SCAN_ACTIVE', message: 'Private fixture path.' }
      })
    openComparison()
    expect(await screen.findByText(/Retry after the scan finishes/)).toBeVisible()
    await waitFor(() => hasScan(side('Target'), 2))
    const calls = source === 'scanner event' ? 0 : 1
    expect(evaluate).toHaveBeenCalledTimes(calls)
    expect(button('Compare snapshots')).toBeDisabled()
    scanState(false)
    await waitFor(() => expect(button('Retry')).toBeVisible())
    expect(evaluate).toHaveBeenCalledTimes(calls)
    click(button('Retry'))
    await compatible()
    expect(evaluate).toHaveBeenCalledTimes(calls + 1)
  }
)

test.each([
  ['UNAVAILABLE', /Saved scan storage is unavailable/],
  ['COMPARISON_TIMEOUT', /request timed out/]
] as const)(
  'offers retry for compatibility failure %s without exposing raw errors',
  async (code, message) => {
    evaluate.mockResolvedValueOnce({ ok: false, error: { code, message: 'Private fixture path.' } })
    openComparison()
    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.queryByText('Private fixture path.')).toBeNull()
    click(button('Retry'))
    await compatible()
  }
)

test.each([
  [{ code: 'INCOMPATIBLE_SCAN_SEMANTICS' }, /incompatible scan rules/],
  [
    { code: 'INSUFFICIENT_COMPATIBILITY_METADATA', side: 'baseline', field: 'scan-semantics' },
    /too little saved information/
  ],
  [{ code: 'SNAPSHOT_EXPIRED', side: 'baseline' }, /baseline snapshot is no longer retained/]
] as const)('uses the authoritative reason for a manually chosen pair', async (reason, message) => {
  rows = [saved(3), saved(2), saved(1)]
  openComparison()
  await compatible()
  evaluate.mockResolvedValueOnce({
    ok: true,
    value: { status: 'incompatible', pair: pair(1, 3), reason }
  })
  await choose('baseline', 1)
  expect(await screen.findByText(message)).toBeVisible()
  expect(button('Compare snapshots')).toBeDisabled()
  expect(prepare).not.toHaveBeenCalled()
})

test('keeps prior adoption through failed preparation and adoption, then accepts overlapping and disjoint replacements', async () => {
  rows = [saved(4), saved(3), saved(2), saved(1)]
  openComparison()
  await compare()
  await choose('baseline', 2)
  await compatible()
  prepare.mockResolvedValueOnce({
    ok: false,
    error: { code: 'SNAPSHOT_UNAVAILABLE', message: 'Private fixture path.' }
  })
  click(button('Compare snapshots'))
  expect(await screen.findByRole('alert')).toHaveTextContent('failed historical validation')
  hasScan(active(), 3)
  adopt.mockResolvedValueOnce({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED', message: 'Private fixture path.' }
  })
  click(button('Compare snapshots'))
  expect(await screen.findByRole('alert')).toHaveTextContent('preparation expired')
  await waitFor(() => expect(discard).toHaveBeenCalledWith({ ticket: '2' }))
  hasScan(active(), 3)
  click(button('Compare snapshots'))
  await waitFor(() => hasScan(active(), 2))
  expect(prepare).toHaveBeenLastCalledWith(pair(2, 4))
  await choose('baseline', 1)
  await choose('target', 3)
  await compatible()
  click(button('Compare snapshots'))
  await waitFor(() => hasScan(active(), 1))
  expect(prepare).toHaveBeenLastCalledWith(pair(1, 3))
  expect(release).not.toHaveBeenCalled()
})

test('ignores A-to-B-to-A stale compatibility replies', async () => {
  rows = [saved(3), saved(2), saved(1)]
  const old =
    Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['evaluateComparisonCompatibility']>>>()
  evaluate.mockReturnValueOnce(old.promise)
  openComparison()
  await waitFor(() => expect(evaluate).toHaveBeenCalledWith(pair(2, 3)))
  await choose('baseline', 1)
  await compatible()
  await choose('baseline', 2)
  await compatible()
  await act(async () =>
    old.resolve({
      ok: true,
      value: { status: 'incompatible', pair: pair(2, 3), reason: { code: 'DIFFERENT_ROOTS' } }
    })
  )
  expect(button('Compare snapshots')).toBeEnabled()
  expect(screen.queryByText(/different roots/)).toBeNull()
})

test('suppresses duplicate Compare and discards an obsolete A-to-B-to-A preparation ticket', async () => {
  rows = [saved(3), saved(2), saved(1)]
  const old =
    Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['prepareComparisonSelection']>>>()
  prepare.mockReturnValueOnce(old.promise)
  openComparison()
  await compatible()
  click(button('Compare snapshots'))
  click(button(/Preparing comparison/))
  expect(prepare).toHaveBeenCalledTimes(1)
  await choose('baseline', 1)
  await choose('baseline', 2)
  await compare()
  await act(async () =>
    old.resolve({
      ok: true,
      value: { ticket: 'obsolete', compatibility: compatibility(pair(2, 3)) as CompatiblePair }
    })
  )
  expect(discard).toHaveBeenCalledExactlyOnceWith({ ticket: 'obsolete' })
  expect(adopt).toHaveBeenCalledExactlyOnceWith({ ticket: '1' })
  expect(release).not.toHaveBeenCalled()
})

test.each(['Scans', 'Overview', 'unmount'])(
  'discards late preparation after leaving for %s',
  async (destination) => {
    const late =
      Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['prepareComparisonSelection']>>>()
    prepare.mockReturnValueOnce(late.promise)
    const view = openComparison()
    await compatible()
    click(button('Compare snapshots'))
    if (destination === 'Scans') click(tab('Scans'))
    else if (destination === 'Overview') nav('Overview')
    else view.unmount()
    await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith({ selectionId: null }))
    await act(async () =>
      late.resolve({
        ok: true,
        value: { ticket: 'late', compatibility: compatibility(pair(1, 2)) as CompatiblePair }
      })
    )
    expect(discard).toHaveBeenCalledExactlyOnceWith({ ticket: 'late' })
    expect(adopt).not.toHaveBeenCalled()
  }
)

test('releases the authoritative late adoption before preparing a new visit', async () => {
  const late =
    Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['adoptComparisonSelection']>>>()
  adopt.mockReturnValueOnce(late.promise)
  openComparison()
  await compatible()
  click(button('Compare snapshots'))
  await waitFor(() => expect(adopt).toHaveBeenCalledOnce())
  nav('Overview')
  nav('History')
  click(tab('Comparison'))
  await compatible()
  click(button('Compare snapshots'))
  expect(prepare).toHaveBeenCalledTimes(1)
  await act(async () =>
    late.resolve({
      ok: true,
      value: { selectionId: 'late-adoption', compatibility: tickets.get('1')! }
    })
  )
  await screen.findByRole('region', { name: 'Active comparison' })
  expect(release).toHaveBeenCalledExactlyOnceWith({ selectionId: 'late-adoption' })
  expect(release.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[1])
  expect(adopt).toHaveBeenLastCalledWith({ ticket: '2' })
})

test('refreshes Latest and removed draft metadata without replacing the active pair or substituting a snapshot', async () => {
  rows = [saved(3), saved(2), saved(1)]
  openComparison()
  await compare()
  await choose('baseline', 1)
  await compatible()
  rows = [saved(4), ...rows]
  scanState(false, true)
  await waitFor(() => expect(within(side('Target')).queryByText('Latest')).toBeNull())
  hasScan(side('Target'), 3)
  hasScan(active(), 2)
  hasScan(active(), 3)
  const calls = evaluate.mock.calls.length
  rows = rows.filter((scan) => scan.id !== '4')
  scanState(false, true)
  expect(await within(side('Target')).findByText('Latest')).toBeVisible()
  expect(evaluate).toHaveBeenCalledTimes(calls)
  rows = rows.filter((scan) => scan.id !== '1')
  scanState(false, true)
  expect(
    await within(side('Baseline')).findByText('This snapshot is no longer retained.')
  ).toBeVisible()
  hasScan(side('Baseline'), 1)
  expect(button('Compare snapshots')).toBeDisabled()
  hasScan(active(), 2)
  expect(release).not.toHaveBeenCalled()
})
