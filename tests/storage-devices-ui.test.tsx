import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import type { StorageDevice } from '../src/shared/storage'
import { StorageDevices } from '../src/renderer/src/features/overview/StorageDevices'

type Reply = Awaited<ReturnType<SpaceLensAPI['getStorageDevices']>>

const fixed: StorageDevice = {
  id: 'V:',
  rootPath: 'V:\\',
  volumeLabel: 'Data archive',
  type: 'fixed',
  capacity: {
    totalBytes: '2000000000000',
    usedBytes: '1480000000000',
    freeBytes: '520000000000',
    usedPercentage: 74
  }
}
const removable: StorageDevice = {
  id: 'Q:',
  rootPath: 'Q:\\',
  volumeLabel: null,
  type: 'removable',
  capacity: null
}
const getStorageDevices = vi.fn<SpaceLensAPI['getStorageDevices']>()
const timeout: Reply = { ok: false, error: { code: 'TIMEOUT', message: 'Private diagnostic' } }

beforeEach(() => {
  getStorageDevices.mockReset()
  vi.stubGlobal('spaceLens', { getStorageDevices })
})
afterEach(() => vi.unstubAllGlobals())

test('shows initial loading, then real drive identifiers, volumes, capacity and usage', async () => {
  const pending = Promise.withResolvers<Reply>()
  getStorageDevices.mockReturnValueOnce(pending.promise)
  render(
    <StrictMode>
      <StorageDevices completedScanId={null} />
    </StrictMode>
  )
  expect(screen.getByRole('status')).toHaveTextContent('Loading drive information')
  expect(screen.getByRole('button', { name: 'Refresh drive information' })).toBeDisabled()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  await act(async () => pending.resolve({ ok: true, value: [fixed, removable] }))
  expect(getStorageDevices).toHaveBeenCalledTimes(1)
  const card = within(screen.getByRole('region', { name: 'Data archive (V:)' }))
  expect(card.getByText('V:\\ · Fixed drive')).toBeVisible()
  expect(card.getByText('2 TB')).toBeVisible()
  expect(card.getByText('1.48 TB')).toBeVisible()
  expect(card.getByText('520 GB')).toBeVisible()
  expect(card.getByText('Free')).toBeVisible()
  expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '74')
  expect(card.getByRole('progressbar')).toHaveAttribute(
    'aria-valuetext',
    '74% used (1.48 TB of 2 TB); 520 GB free'
  )
  const unavailable = within(screen.getByRole('region', { name: 'Q:' }))
  expect(unavailable.getByText('Q:\\ · Removable drive')).toBeVisible()
  expect(unavailable.getByText('Capacity unavailable.')).toBeVisible()
  expect(unavailable.queryByRole('progressbar')).not.toBeInTheDocument()
  expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(2)
})

test('shows a sanitized initial error, retries, and distinguishes an empty drive result', async () => {
  getStorageDevices.mockResolvedValueOnce(timeout).mockResolvedValueOnce({ ok: true, value: [] })
  render(<StorageDevices completedScanId={null} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Drive discovery timed out.')
  expect(screen.queryByText(/Private diagnostic/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry drive information' }))
  expect(await screen.findByText('No supported drives were found.')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('keeps the last result during refresh, signals staleness on failure, and replaces removed drives on retry', async () => {
  const pending = Promise.withResolvers<Reply>()
  getStorageDevices
    .mockResolvedValueOnce({ ok: true, value: [fixed] })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ ok: true, value: [removable] })
  render(<StorageDevices completedScanId={null} />)
  const heading = await screen.findByRole('heading', { name: 'Data archive (V:)' })
  const refresh = screen.getByRole('button', { name: 'Refresh drive information' })
  fireEvent.click(refresh)
  fireEvent.click(refresh)
  expect(getStorageDevices).toHaveBeenCalledTimes(2)
  expect(heading).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing drive information')
  await act(async () => pending.reject(new Error('Private diagnostic')))
  expect(screen.getByRole('alert')).toHaveTextContent('may be outdated')
  expect(heading).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Retry drive information' }))
  expect(await screen.findByRole('heading', { name: 'Q:' })).toBeVisible()
  expect(heading).not.toBeInTheDocument()
  expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(1)
})

test('coalesces scan completions during a drive query and ignores the older reply', async () => {
  const obsolete = Promise.withResolvers<Reply>()
  const latest = Promise.withResolvers<Reply>()
  getStorageDevices.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(latest.promise)
  const view = render(<StorageDevices completedScanId={null} />)
  await waitFor(() => expect(getStorageDevices).toHaveBeenCalledTimes(1))
  view.rerender(<StorageDevices completedScanId="a" />)
  view.rerender(<StorageDevices completedScanId="b" />)
  expect(getStorageDevices).toHaveBeenCalledTimes(1)
  await act(async () => obsolete.resolve({ ok: true, value: [fixed] }))
  expect(screen.queryByRole('heading', { name: 'Data archive (V:)' })).not.toBeInTheDocument()
  expect(getStorageDevices).toHaveBeenCalledTimes(2)
  await act(async () => latest.resolve({ ok: true, value: [removable] }))
  expect(screen.getByRole('heading', { name: 'Q:' })).toBeVisible()
})

test('rejects an unmounted response and keeps the last successful result on re-entry', async () => {
  const cache: { current: readonly StorageDevice[] | null } = { current: null }
  const old = Promise.withResolvers<Reply>()
  const current = Promise.withResolvers<Reply>()
  getStorageDevices
    .mockResolvedValueOnce({ ok: true, value: [fixed] })
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise)
  const first = render(<StorageDevices completedScanId={null} cache={cache} />)
  await screen.findByRole('heading', { name: 'Data archive (V:)' })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh drive information' }))
  first.unmount()
  render(<StorageDevices completedScanId={null} cache={cache} />)
  expect(await screen.findByRole('heading', { name: 'Data archive (V:)' })).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing drive information')
  await act(async () => current.resolve({ ok: true, value: [removable] }))
  await act(async () => old.resolve({ ok: true, value: [fixed] }))
  expect(cache.current).toEqual([removable])
  expect(screen.getByRole('heading', { name: 'Q:' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Data archive (V:)' })).not.toBeInTheDocument()
})

test('formats zero and full UInt64 capacity using decimal units', async () => {
  getStorageDevices.mockResolvedValueOnce({
    ok: true,
    value: [
      {
        ...fixed,
        capacity: {
          totalBytes: '18446744073709551615',
          usedBytes: '18446744073709551615',
          freeBytes: '0',
          usedPercentage: 100
        }
      },
      {
        ...removable,
        capacity: { totalBytes: '0', usedBytes: '0', freeBytes: '0', usedPercentage: 0 }
      }
    ]
  })
  render(<StorageDevices completedScanId={null} />)
  const full = await screen.findByRole('progressbar', { name: 'Data archive (V:) storage used' })
  expect(full).toHaveAttribute(
    'aria-valuetext',
    '100% used (18,446.74 PB of 18,446.74 PB); 0 B free'
  )
  expect(screen.getByRole('progressbar', { name: 'Q: storage used' })).toHaveAttribute(
    'aria-valuetext',
    '0% used (0 B of 0 B); 0 B free'
  )
})
