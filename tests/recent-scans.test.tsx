import { afterEach, expect, test, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { RecentScanSummary } from '../src/shared/scan'
import { RecentScans } from '../src/renderer/src/features/overview/RecentScans'
import { OverviewPage } from '../src/renderer/src/pages/OverviewPage'

afterEach(() => vi.unstubAllGlobals())

function createScanSummary(
  id: string,
  completedAt: string,
  overrides: Partial<RecentScanSummary> = {}
): RecentScanSummary {
  return {
    id,
    path: `C:\\Test fixtures\\${id}`,
    completedAt,
    totalBytes: 12_500_000_000,
    fileCount: 12_345,
    ...overrides
  }
}

test('empty state explains where completed scans will appear without fabricated entries or actions', () => {
  render(<RecentScans scan={null} status="ready" />)

  expect(screen.getByRole('heading', { name: 'Recent Scans' })).toBeVisible()
  expect(screen.getAllByRole('region', { name: 'Recent Scans' })).toHaveLength(1)
  expect(screen.getByRole('heading', { name: 'No scans yet' })).toBeVisible()
  expect(screen.getByText(/Completed scans will appear here/)).toBeVisible()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

test('populated state displays location, completion time, decimal GB and grouped file counts', () => {
  const completedAt = '2026-11-05T14:30:00Z'
  const scan = createScanSummary('documents', completedAt)
  render(<RecentScans scan={scan} status="ready" />)

  expect(screen.getByText(scan.path)).toBeVisible()
  expect(screen.getByText('Nov 5, 2026, 14:30')).toHaveAttribute('datetime', completedAt)
  expect(screen.getByText('Analyzed')).toBeVisible()
  expect(screen.getByText('12.5 GB')).toBeVisible()
  expect(screen.getByText('Files')).toBeVisible()
  expect(screen.getByText('12,345')).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'No scans yet' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})

test('replaces the single published row and preserves the new completion time and errors', () => {
  const first = createScanSummary('first', '2026-11-05T11:00:00+02:00')
  const next = createScanSummary('next', '2026-11-05T14:30:00Z', {
    directoryCount: 4567,
    errorCount: 2
  })
  const { rerender } = render(<RecentScans scan={first} status="ready" />)
  rerender(<RecentScans scan={next} status="ready" />)
  const row = screen.getByRole('listitem')
  expect(within(row).getByText(next.path)).toBeVisible()
  expect(within(row).getByText('4,567')).toBeVisible()
  expect(within(row).getByText(/2 filesystem errors/)).toBeVisible()
  expect(within(row).getByText('Nov 5, 2026, 14:30')).toHaveAttribute('datetime', next.completedAt)
  expect(screen.queryByText(first.path)).not.toBeInTheDocument()
})

test('distinguishes startup recovery from unavailable storage and an empty publication', () => {
  const { rerender } = render(<RecentScans scan={null} status="loading" />)
  expect(screen.getByRole('status')).toHaveTextContent(/Loading saved scan/)
  expect(screen.queryByText('No scans yet')).not.toBeInTheDocument()
  rerender(<RecentScans scan={null} status="unavailable" />)
  expect(screen.getByRole('alert')).toHaveTextContent(/Saved scan storage is unavailable/)
  expect(screen.queryByText('No scans yet')).not.toBeInTheDocument()
  rerender(<RecentScans scan={null} status="ready" />)
  expect(screen.getByText('No scans yet')).toBeVisible()
})

test('preserves unusual paths as text and displays zero sizes and file counts', () => {
  const path = 'D:\\Архів & notes\\<img src=x onerror=alert(1)>'
  render(
    <RecentScans
      status="ready"
      scan={createScanSummary('unusual', '2026-11-05T10:00:00Z', {
        path,
        totalBytes: 0,
        fileCount: 0
      })}
    />
  )

  expect(screen.getByText(path, { exact: true })).toBeVisible()
  expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument()
  expect(screen.getByText('0 GB')).toBeVisible()
  expect(screen.getByText('0', { exact: true })).toBeVisible()
})

test('Overview preserves demo devices and empty Recent Scans while enabling folder selection', async () => {
  vi.stubGlobal('spaceLens', {
    getScanState: async () => ({ ok: true, value: { revision: 0, state: null } }),
    onScanStateChanged: () => () => {}
  })
  render(<OverviewPage />)

  expect(await screen.findByRole('heading', { name: 'No scans yet' })).toBeVisible()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Demo scans' })).not.toBeInTheDocument()
  expect(screen.getAllByText('Demo data')).toHaveLength(1)
  await screen.findByText('Ready to scan')
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
})
