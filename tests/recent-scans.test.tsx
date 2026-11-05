import { expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { RecentScanSummary } from '../src/shared/scan'
import { RecentScans } from '../src/renderer/src/features/overview/RecentScans'
import { OverviewPage } from '../src/renderer/src/pages/OverviewPage'

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
  render(<RecentScans scans={[]} />)

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
  render(<RecentScans scans={[scan]} />)

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

test('renders only the five newest scans without mutating the supplied summaries', () => {
  const scans = Object.freeze(
    [2, 0, 5, 1, 4, 3].map((index) =>
      Object.freeze(createScanSummary(`entry-${index}`, `2026-11-05T0${index}:00:00Z`))
    )
  )
  render(<RecentScans scans={scans} />)

  const rows = within(screen.getByRole('list')).getAllByRole('listitem')
  expect(rows).toHaveLength(5)
  expect(screen.getByText('Showing latest 5')).toBeVisible()
  expect(screen.queryByText('C:\\Test fixtures\\entry-0')).not.toBeInTheDocument()
  rows.forEach((row, index) => {
    expect(within(row).getByText(`C:\\Test fixtures\\entry-${5 - index}`)).toBeVisible()
  })
  expect(scans.map(({ id }) => id)).toEqual([
    'entry-2',
    'entry-0',
    'entry-5',
    'entry-1',
    'entry-4',
    'entry-3'
  ])
})

test('compares timestamps by actual completion time, including timezone offsets', () => {
  const earlier = createScanSummary('earlier', '2026-11-05T11:00:00+02:00')
  const later = createScanSummary('later', '2026-11-05T10:00:00Z')
  render(<RecentScans scans={[earlier, later]} />)

  const rows = within(screen.getByRole('list')).getAllByRole('listitem')
  expect(within(rows[0]).getByText(later.path)).toBeVisible()
  expect(within(rows[1]).getByText(earlier.path)).toBeVisible()
})

test('preserves unusual paths as text and displays zero sizes and file counts', () => {
  const path = 'D:\\Архів & notes\\<img src=x onerror=alert(1)>'
  render(
    <RecentScans
      scans={[
        createScanSummary('unusual', '2026-11-05T10:00:00Z', {
          path,
          totalBytes: 0,
          fileCount: 0
        })
      ]}
    />
  )

  expect(screen.getByText(path, { exact: true })).toBeVisible()
  expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument()
  expect(screen.getByText('0 GB')).toBeVisible()
  expect(screen.getByText('0', { exact: true })).toBeVisible()
})

test('Overview defaults to the empty state and keeps Scan Folder disabled', () => {
  render(<OverviewPage />)

  expect(screen.getByRole('heading', { name: 'No scans yet' })).toBeVisible()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Demo scans' })).not.toBeInTheDocument()
  expect(screen.getAllByText('Demo data')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toHaveAccessibleDescription(
    'Coming soon'
  )
})
