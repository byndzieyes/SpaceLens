import { afterEach, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ScanHistoryItem } from '../src/shared/history'
import type { ScanStateSnapshot, SpaceLensAPI } from '../src/shared/ipc'
import type { RecentScanSummary } from '../src/shared/scan'
import { RecentScans } from '../src/renderer/src/features/overview/RecentScans'
import { OverviewPage } from '../src/renderer/src/pages/OverviewPage'
import { recentHistoryPage, recentScanItem } from './recent-scans-fixture'

afterEach(() => vi.unstubAllGlobals())

function saved(
  id: string,
  completedAt = '2026-11-05T14:30:00Z',
  overrides: Partial<RecentScanSummary> = {}
): ScanHistoryItem {
  return recentScanItem({
    id,
    path: `C:\\Test fixtures\\${id}`,
    completedAt,
    totalBytes: 12_500_000_000,
    fileCount: 12_345,
    ...overrides
  })
}

function recent(): ReturnType<typeof within> {
  return within(screen.getByRole('region', { name: 'Recent Scans' }))
}

function scannerApi(items: readonly ScanHistoryItem[] = []): {
  list: ReturnType<typeof vi.fn<SpaceLensAPI['listScanHistory']>>
  metadata: ReturnType<typeof vi.fn<SpaceLensAPI['getScanHistoryMetadata']>>
  analytics: ReturnType<typeof vi.fn<SpaceLensAPI['getInsightsSummary']>>
  publish: (historyRevision: number) => void
  listeners: Set<Parameters<SpaceLensAPI['onScanStateChanged']>[0]>
} {
  let state: ScanStateSnapshot = { revision: 0, state: null, publicationStatus: 'ready' }
  const list = vi.fn<SpaceLensAPI['listScanHistory']>(async () => ({
    ok: true,
    value: recentHistoryPage(items)
  }))
  const metadata = vi.fn<SpaceLensAPI['getScanHistoryMetadata']>()
  const analytics = vi.fn<SpaceLensAPI['getInsightsSummary']>()
  const listeners = new Set<Parameters<SpaceLensAPI['onScanStateChanged']>[0]>()
  vi.stubGlobal('spaceLens', {
    getScanState: async () => ({ ok: true, value: state }),
    onScanStateChanged: (listener: Parameters<SpaceLensAPI['onScanStateChanged']>[0]) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listScanHistory: list,
    getScanHistoryMetadata: metadata,
    getInsightsSummary: analytics
  })
  return {
    list,
    metadata,
    analytics,
    listeners,
    publish: (historyRevision) => {
      act(() => {
        state = { ...state, revision: state.revision + 1, historyRevision }
        for (const listener of listeners) listener(state)
      })
    }
  }
}

test('empty state explains where completed scans will appear without fabricated entries or actions', () => {
  render(<RecentScans state={{ status: 'ready', page: recentHistoryPage() }} onRetry={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'Recent Scans' })).toBeVisible()
  expect(screen.getAllByRole('region', { name: 'Recent Scans' })).toHaveLength(1)
  expect(screen.getByRole('heading', { name: 'No scans yet' })).toBeVisible()
  expect(screen.getByText(/Completed scans will appear here/)).toBeVisible()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

test('displays persisted path, duration, time, decimal GB, grouped counts and the global Latest indicator', () => {
  const scan = saved('documents')
  const open = vi.fn()
  render(
    <RecentScans
      state={{ status: 'ready', page: recentHistoryPage([scan]) }}
      onRetry={vi.fn()}
      onOpenSnapshot={open}
    />
  )
  expect(screen.getByText(scan.rootPath)).toBeVisible()
  expect(screen.getByText('Nov 5, 2026, 14:30')).toHaveAttribute('datetime', scan.finishedAt)
  expect(screen.getByText('Known logical size')).toBeVisible()
  expect(screen.getByText('12.5 GB')).toBeVisible()
  expect(screen.getByText('Files')).toBeVisible()
  expect(screen.getByText('12,345')).toBeVisible()
  expect(screen.getByText('1 m 5 s')).toBeVisible()
  expect(screen.getByText('Latest')).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'No scans yet' })).not.toBeInTheDocument()
  const explorer = screen.getByRole('button', { name: /Open in Explorer for.*documents/ })
  explorer.focus()
  expect(explorer).toHaveFocus()
  fireEvent.click(explorer)
  fireEvent.click(screen.getByRole('button', { name: /Open in Insights for.*documents/ }))
  expect(open.mock.calls).toEqual([
    ['explorer', scan.id],
    ['insights', scan.id]
  ])
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

test('refresh applies the replacement Latest, removes deleted records and preserves error metadata', () => {
  const first = saved('first', '2026-11-05T11:00:00+02:00')
  const next = saved('next', '2026-11-05T14:30:00Z', { directoryCount: 4567, errorCount: 2 })
  const retry = vi.fn()
  const { rerender } = render(
    <RecentScans
      state={{ status: 'ready', page: recentHistoryPage([first, next]) }}
      onRetry={retry}
    />
  )
  expect(within(screen.getAllByRole('listitem')[0]).getByText('Latest')).toBeVisible()
  rerender(
    <RecentScans state={{ status: 'ready', page: recentHistoryPage([next]) }} onRetry={retry} />
  )
  const row = screen.getByRole('listitem')
  expect(within(row).getByText(next.rootPath)).toBeVisible()
  expect(within(row).getByText('Latest')).toBeVisible()
  expect(within(row).getByText('4,567')).toBeVisible()
  expect(within(row).getByText(/2 filesystem errors/)).toBeVisible()
  expect(within(row).getByText(/Incomplete result/)).toBeVisible()
  expect(within(row).getByText('Nov 5, 2026, 14:30')).toHaveAttribute('datetime', next.finishedAt)
  expect(screen.queryByText(first.rootPath)).not.toBeInTheDocument()
})

test('preserves unusual paths as text and displays zero sizes and file counts', () => {
  const path = 'D:\\Архів & notes\\<img src=x onerror=alert(1)>'
  render(
    <RecentScans
      state={{
        status: 'ready',
        page: recentHistoryPage([
          saved('unusual', '2026-11-05T10:00:00Z', { path, totalBytes: 0, fileCount: 0 })
        ])
      }}
      onRetry={vi.fn()}
    />
  )
  expect(screen.getByText(path, { exact: true })).toBeVisible()
  expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument()
  expect(screen.getByText('0 GB')).toBeVisible()
  expect(screen.getByText('0', { exact: true })).toBeVisible()
})

test.each([1, 4, 5, 7])(
  'uses the bounded History page in server order with %i retained records',
  async (count) => {
    const items = Array.from({ length: count }, (_, i) =>
      saved(`id-${i}`, i === 0 || i === 2 ? '2026-11-05T07:30:00Z' : '2026-11-05T20:30:00Z', {
        path: `/${i % 2 ? 'external' : 'local'}/scan-${i}`
      })
    )
    const { list, metadata, analytics } = scannerApi(items)
    render(<OverviewPage />)
    await recent().findByText(items[0].rootPath)
    const rows = recent().getAllByRole('listitem')
    expect(rows).toHaveLength(Math.min(5, count))
    rows.forEach((row, i) => expect(within(row).getByText(items[i].rootPath)).toBeVisible())
    expect(within(rows[0]).getByText('Latest')).toBeVisible()
    expect(recent().getAllByText('Latest')).toHaveLength(1)
    expect(list).toHaveBeenCalledExactlyOnceWith({ offset: 0, limit: 5, sort: 'newest' })
    expect(metadata).not.toHaveBeenCalled()
    expect(analytics).not.toHaveBeenCalled()
  }
)

test('Overview preserves demo devices and empty Recent Scans while enabling folder selection', async () => {
  scannerApi()
  render(<OverviewPage />)
  expect(await screen.findByRole('heading', { name: 'No scans yet' })).toBeVisible()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.getAllByText('Demo data')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Demo scans' })).not.toBeInTheDocument()
  await screen.findByText('Ready to scan')
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
})

test.each([
  ['UNAVAILABLE', 'Saved scan storage is unavailable.'],
  ['UNAUTHORIZED', 'Recent scans are unavailable in this window.'],
  ['INTERNAL_ERROR', 'Recent scans could not be loaded.']
] as const)(
  'shows and retries %s without affecting scanner and storage cards',
  async (code, message) => {
    const restored = saved('restored')
    const { list } = scannerApi([restored])
    list.mockResolvedValueOnce({ ok: false, error: { code, message: 'private diagnostic' } })
    render(<OverviewPage />)
    expect(recent().getByRole('status')).toHaveTextContent('Loading saved scans')
    expect(await recent().findByRole('alert')).toHaveTextContent(message)
    expect(recent().queryByText('No scans yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
    expect(screen.getByRole('region', { name: 'Storage Devices' })).toBeVisible()
    fireEvent.click(recent().getByRole('button', { name: 'Retry recent scans' }))
    expect(await recent().findByText(restored.rootPath)).toBeVisible()
    expect(recent().queryByRole('alert')).not.toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  }
)

test('coalesces publication and pruning during startup and drops the obsolete initial page', async () => {
  const obsolete = saved('obsolete')
  const retained = saved('retained')
  const { list, publish, listeners } = scannerApi([retained])
  const first = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockImplementationOnce(() => {
    expect(listeners.size).toBe(1)
    return first.promise
  })
  render(<OverviewPage />)
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  publish(1)
  publish(2)
  publish(2)
  expect(list).toHaveBeenCalledOnce()
  expect(recent().getByRole('status')).toHaveTextContent('Loading saved scans')
  await act(async () => first.resolve({ ok: true, value: recentHistoryPage([obsolete]) }))
  expect(await recent().findByText(retained.rootPath)).toBeVisible()
  expect(recent().queryByText(obsolete.rootPath)).not.toBeInTheDocument()
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => publish(2))
  expect(list).toHaveBeenCalledTimes(2)
})

test('retains the prior page while refreshing, then shows the replacement Latest and final empty history', async () => {
  const archive = saved('first')
  const latest = saved('second')
  const { list, publish } = scannerApi([latest, archive])
  render(<OverviewPage />)
  await recent().findByText(latest.rootPath)
  const deletion = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(deletion.promise)
  publish(1)
  expect(await recent().findByRole('status')).toHaveTextContent('Refreshing recent scans')
  expect(recent().getByText(latest.rootPath)).toBeVisible()
  expect(recent().queryByText('No scans yet')).not.toBeInTheDocument()
  await act(async () => deletion.resolve({ ok: true, value: recentHistoryPage([archive]) }))
  expect(recent().queryByText(latest.rootPath)).not.toBeInTheDocument()
  expect(within(recent().getByRole('listitem')).getByText('Latest')).toBeVisible()
  list.mockResolvedValueOnce({ ok: true, value: recentHistoryPage() })
  publish(2)
  expect(await recent().findByRole('heading', { name: 'No scans yet' })).toBeVisible()
  expect(recent().queryByText(archive.rootPath)).not.toBeInTheDocument()
})

test('ignores a pending reply after Overview unmounts and reads fresh history on reentry', async () => {
  const removed = saved('removed')
  const restored = saved('restored')
  const { list, listeners } = scannerApi([restored])
  const late = Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listScanHistory']>>>()
  list.mockReturnValueOnce(late.promise)
  const view = render(<OverviewPage />)
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  view.unmount()
  expect(listeners.size).toBe(0)
  render(<OverviewPage />)
  expect(await recent().findByText(restored.rootPath)).toBeVisible()
  await act(async () => late.resolve({ ok: true, value: recentHistoryPage([removed]) }))
  expect(recent().getByText(restored.rootPath)).toBeVisible()
  expect(recent().queryByText(removed.rootPath)).not.toBeInTheDocument()
  expect(list).toHaveBeenCalledTimes(2)
})
