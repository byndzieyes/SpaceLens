import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import type { ScanHistoryItem } from '../src/shared/history'
import type { StorageTrends, TrendPoint, TrendSeries } from '../src/shared/trends'
import { TrendsWorkspace } from '../src/renderer/src/features/trends/TrendsWorkspace'

const alpha = {
  normalizedRoot: '/archive/a',
  pathStyle: 'posix',
  traversalPolicy: 'fixture'
} as const
const beta = { ...alpha, normalizedRoot: '/archive/old%_b' }
const stamp = '2026-11-22T12:00:00.000Z'
const query = vi.fn<SpaceLensAPI['getStorageTrends']>()
const list = vi.fn<SpaceLensAPI['listScanHistory']>()
const onOpen = vi.fn()

function point(id: number, totalBytes = id, extra?: Partial<TrendPoint>): TrendPoint {
  return {
    id: 'scan-' + id,
    finishedAt: stamp,
    totalBytes,
    fileCount: id,
    directoryCount: id + 1,
    incomplete: false,
    ...extra
  }
}

function result(
  points: TrendPoint[],
  series: TrendSeries | null = alpha,
  retainedCount = points.length,
  latestCompletedScanId = points.at(-1)?.id ?? null
): { ok: true; value: StorageTrends } {
  return { ok: true, value: { points, series, retainedCount, latestCompletedScanId } }
}

function saved(id: number, rootPath: string): ScanHistoryItem {
  return {
    id: 'scan-' + id,
    rootPath,
    status: 'completed',
    startedAt: stamp,
    finishedAt: stamp,
    durationMs: 0,
    isLatest: false,
    incomplete: false,
    summary: { totalBytes: id, fileCount: id, directoryCount: id + 1, errorCount: 0 }
  }
}

function workspace(historyRevision = 0, active = true): React.JSX.Element {
  return (
    <TrendsWorkspace
      active={active}
      historyRevision={historyRevision}
      onOpen={onOpen}
      onOpenPicker={vi.fn()}
    />
  )
}

function buttons(chart: HTMLElement): HTMLElement[] {
  return within(chart).getAllByRole('button', { name: /^Scan \d+,/ })
}

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '')
      }
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open')
      }
    }
  })
})
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})
beforeEach(() => {
  query.mockReset().mockResolvedValue(result([], null))
  list.mockReset()
  onOpen.mockReset()
  vi.stubGlobal('spaceLens', { getStorageTrends: query, listScanHistory: list })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('loads only when active and distinguishes empty, singleton, and constant zero chart geometry', async () => {
  const { rerender } = render(workspace(0, false))
  await act(async () => {})
  expect(query).not.toHaveBeenCalled()
  rerender(workspace())
  expect(await screen.findByText(/No saved snapshots yet/)).toBeVisible()
  expect(screen.queryByRole('figure')).toBeNull()
  query.mockResolvedValue(result([point(1, 0, { fileCount: 0 })]))
  rerender(workspace(1))
  const chart = await screen.findByRole('figure', {
    name: /Logical size by scan publication order/
  })
  expect(screen.getByText(/One retained snapshot/)).toBeVisible()
  expect(buttons(chart)).toHaveLength(1)
  expect(chart.querySelector('polyline')).toBeNull()
  expect(within(chart).getByTitle('0 bytes')).toHaveTextContent('0 B')
  expect(within(chart).getByText('No previous point in this window')).toBeVisible()
  query.mockResolvedValue(result([point(1, 0), point(2, 0)]))
  rerender(workspace(2))
  await waitFor(() => expect(buttons(chart)).toHaveLength(2))
  expect(chart.querySelector('polyline')).toHaveAttribute('points', '4,50 96,50')
  expect(chart.querySelector('polygon')).toBeNull()
  expect(within(chart).getByText('0 B from previous scan')).toBeVisible()
  expect(screen.queryByText(/%$/)).toBeNull()
})

test('keeps exact publication identities and deltas with duplicate times, partial coverage and local metrics', async () => {
  query.mockResolvedValue(
    result(
      [
        point(1, 0),
        point(2, Number.MAX_SAFE_INTEGER, { incomplete: true }),
        point(3, 5, { fileCount: 2, finishedAt: '2026-11-21T12:00:00.000Z' }),
        point(4, 5, { fileCount: 2 })
      ],
      alpha,
      4,
      'different-root'
    )
  )
  render(workspace())
  const chart = await screen.findByRole('figure')
  const markers = buttons(chart)
  expect(markers[1]).toHaveAccessibleName(/Scan 2, .*partial coverage/)
  expect(markers[3]).toHaveAttribute('tabindex', '0')
  act(() => markers[3].focus())
  fireEvent.keyDown(markers[3], { key: 'Home' })
  expect(markers[0]).toHaveFocus()
  expect(within(chart).getByText('No previous point in this window')).toBeVisible()
  expect(markers[0].getAttribute('aria-label')?.split(',').slice(1, -2)).toEqual(
    markers[1].getAttribute('aria-label')?.split(',').slice(1, -2)
  )
  fireEvent.keyDown(markers[0], { key: 'ArrowRight' })
  expect(markers[1]).toHaveFocus()
  expect(within(chart).getByTitle('9,007,199,254,740,991 bytes')).toBeVisible()
  expect(within(chart).getByText('Partial interval')).toBeVisible()
  expect(screen.getByText(/Observed size and count changes may reflect gaps/)).toBeVisible()
  const timeline = screen.getByRole('table', { name: /newest publication first/ })
  const rows = within(timeline)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row))
  expect(rows[0].getByText('Latest in series')).toBeVisible()
  expect(rows[0].getByTitle('0 bytes')).toBeVisible()
  expect(rows[1].getByTitle('−9,007,199,254,740,986 bytes')).toBeVisible()
  expect(rows[2].getByTitle('+9,007,199,254,740,991 bytes')).toBeVisible()
  expect(rows[3].getByText('Unavailable')).toBeVisible()
  expect(screen.getByText('+1 files · +3 directories')).toBeVisible()
  expect(screen.queryByText(/%$/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Files' }))
  expect(chart).toHaveAccessibleName(/Files by scan publication order/)
  expect(within(chart).getByText('+1 from previous scan')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Directories' }))
  expect(chart).toHaveAccessibleName(/Directories by scan publication order/)
  expect(query).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: /^Actions for scan 3,/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Explorer' }))
  fireEvent.click(screen.getByRole('button', { name: /^Actions for scan 2,/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Insights' }))
  expect(onOpen.mock.calls).toEqual([
    ['explorer', 'scan-3'],
    ['insights', 'scan-2']
  ])
})

test('reports the bounded window and selects an older root after paging and literal filtering', async () => {
  const initial = result(
    Array.from({ length: 100 }, (_, index) => point(index + 46)),
    alpha,
    145
  )
  query
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(result([point(1, 2)], beta, 1, 'scan-145'))
  const recent = Array.from({ length: 20 }, (_, index) => saved(145 - index, alpha.normalizedRoot))
  list.mockImplementation(async ({ offset = 0, rootPathContains } = {}) => {
    const items = rootPathContains || offset ? [saved(1, beta.normalizedRoot)] : recent
    return {
      ok: true,
      value: {
        items,
        totalCount: rootPathContains ? 1 : 21,
        offset,
        limit: 20,
        latestCompletedScanId: 'scan-145',
        nextOffset: offset || rootPathContains ? null : 20
      }
    }
  })
  render(workspace())
  const chart = await screen.findByRole('figure')
  expect(buttons(chart)).toHaveLength(100)
  expect(screen.getByText('Showing the latest 100 of 145 retained snapshots.')).toBeVisible()
  const table = screen.getByRole('table')
  expect(within(table).getAllByRole('row')).toHaveLength(21)
  fireEvent.click(screen.getByRole('button', { name: 'Next timeline page' }))
  expect(screen.getByText('21–40 of 100 displayed snapshots')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Choose scan root' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Choose a scan root' }))
  const next = dialog.getByRole('button', { name: 'Next snapshots' })
  await waitFor(() => expect(next).toBeEnabled())
  fireEvent.click(next)
  expect(await dialog.findByText(beta.normalizedRoot)).toBeVisible()
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ offset: 20 }))
  fireEvent.change(dialog.getByRole('searchbox'), { target: { value: '%_b' } })
  fireEvent.click((await dialog.findByText(beta.normalizedRoot)).closest('button')!)
  expect(await screen.findByText(/One retained snapshot/)).toBeVisible()
  expect(query).toHaveBeenLastCalledWith({ mode: 'snapshot', scanId: 'scan-1' })
  expect(list).toHaveBeenLastCalledWith(
    expect.objectContaining({ offset: 0, rootPathContains: '%_b' })
  )
  expect(screen.getByTitle(beta.normalizedRoot)).toBeVisible()
})

test('preserves the metric and canonical root through refresh, prune, unrelated publication, failure and removal', async () => {
  query.mockResolvedValue(result([point(1, 2), point(2, 6)]))
  const { rerender } = render(workspace())
  await screen.findByText('+200%')
  fireEvent.click(screen.getByRole('button', { name: 'Files' }))
  const older = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['getStorageTrends']>>>()
  query.mockReturnValueOnce(older.promise)
  rerender(workspace(1))
  await waitFor(() => expect(query).toHaveBeenLastCalledWith({ mode: 'series', series: alpha }))
  expect(screen.getByText('Refreshing retained snapshots…')).toBeVisible()
  expect(screen.getByText('+200%')).toBeVisible()
  query.mockResolvedValue(result([point(2, 6), point(3, 3)], alpha, 2, 'unrelated'))
  rerender(workspace(2))
  expect(await screen.findByText('−50%')).toBeVisible()
  await act(() => older.resolve(result([point(1, 2), point(2, 6), point(3, 3)])))
  expect(screen.queryByText('+200%')).toBeNull()
  expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true')
  query.mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', message: 'fixture' } })
  rerender(workspace(3))
  expect(await screen.findByRole('alert')).toHaveTextContent('Saved scan storage is unavailable.')
  expect(screen.getByText('Showing the last loaded observations.')).toBeVisible()
  query.mockResolvedValue(result([point(2, 6)], alpha, 1, 'unrelated'))
  fireEvent.click(screen.getByRole('button', { name: 'Retry trends' }))
  expect(await screen.findByText(/One retained snapshot/)).toBeVisible()
  query.mockResolvedValue(result([], alpha, 0, 'unrelated'))
  rerender(workspace(4))
  expect(await screen.findByText('No retained snapshots remain in this series.')).toBeVisible()
  expect(screen.getByTitle(alpha.normalizedRoot)).toBeVisible()
  expect(screen.queryByRole('figure')).toBeNull()
  rerender(workspace(5, false))
  const calls = query.mock.calls.length
  await act(async () => {})
  expect(query).toHaveBeenCalledTimes(calls)
  rerender(workspace(5))
  await waitFor(() => expect(query).toHaveBeenCalledTimes(calls + 1))
  expect(query).toHaveBeenLastCalledWith({ mode: 'series', series: alpha })
})

test('isolates rapid root changes and ignores a response from a tab that was left', async () => {
  const first = result([point(1, 110)], alpha)
  const second = result([point(2, 210)], beta)
  const pending = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['getStorageTrends']>>>()
  const inactive = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['getStorageTrends']>>>()
  query
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(first)
  list.mockResolvedValue({
    ok: true,
    value: {
      offset: 0,
      limit: 20,
      totalCount: 2,
      items: [saved(2, beta.normalizedRoot), saved(1, alpha.normalizedRoot)],
      latestCompletedScanId: 'scan-2',
      nextOffset: null
    }
  })
  const { rerender } = render(workspace())
  await screen.findByRole('figure')
  const choose = async (root: string): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose scan root' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click((await dialog.findByText(root)).closest('button')!)
  }
  await choose(beta.normalizedRoot)
  expect(screen.getByTitle(beta.normalizedRoot)).toBeVisible()
  expect(screen.queryByRole('figure')).toBeNull()
  await waitFor(() =>
    expect(query).toHaveBeenLastCalledWith({ mode: 'snapshot', scanId: 'scan-2' })
  )
  await choose(alpha.normalizedRoot)
  await screen.findByRole('figure')
  await act(() => pending.resolve(second))
  expect(screen.getByTitle(alpha.normalizedRoot)).toBeVisible()
  expect(screen.queryByText('210 B')).toBeNull()
  query.mockReturnValueOnce(inactive.promise)
  rerender(workspace(1))
  await waitFor(() => expect(query).toHaveBeenCalledTimes(4))
  rerender(workspace(1, false))
  await act(() => inactive.resolve(result([point(3, 310)], alpha)))
  expect(screen.queryByText('310 B')).toBeNull()
  query.mockResolvedValue(first)
  rerender(workspace(1))
  await waitFor(() => expect(query).toHaveBeenCalledTimes(5))
  expect(query).toHaveBeenLastCalledWith({ mode: 'series', series: alpha })
})
