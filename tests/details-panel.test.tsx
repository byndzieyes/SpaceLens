import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import type { FileEntry } from '../src/shared/scan'
import type { ScanSnapshot } from '../src/shared/snapshot'
import { DetailsPanel } from '../src/renderer/src/features/explorer/DetailsPanel'
import { ExplorerPage } from '../src/renderer/src/pages/ExplorerPage'
import { treemapSummary } from './treemap-fixtures'

const file: FileEntry = {
  id: 'file',
  scanId: 'published',
  parentId: 'root',
  name: 'report.txt',
  path: '/root/report.txt',
  type: 'file',
  sizeBytes: 1500,
  aggregatedSizeBytes: null,
  createdAt: '2026-11-16T12:30:00Z',
  modifiedAt: '2026-11-16T15:30:00+02:00'
}
const folder: FileEntry = {
  ...file,
  id: 'folder',
  name: 'Documents',
  path: '/root/Documents',
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 2500,
  createdAt: null,
  modifiedAt: null
}
const root: FileEntry = { ...folder, id: 'root', name: 'Root', path: '/root', parentId: null }
const snapshot: ScanSnapshot = {
  entries: { scanId: 'published', rootEntryId: 'root' },
  root,
  completedAt: '2026-11-16T16:00:00Z',
  entryCount: 3,
  incomplete: true,
  summary: { fileCount: 1, directoryCount: 2, totalBytes: 2500, errorCount: 1 }
}
const getEntry = vi.fn<SpaceLensAPI['getScanEntry']>()
const props = { scanId: 'published', selectedEntryId: 'file' }
type EntryResult = Awaited<ReturnType<SpaceLensAPI['getScanEntry']>>

function deferred(): { promise: Promise<EntryResult>; resolve: (value: EntryResult) => void } {
  let resolve!: (value: EntryResult) => void
  const promise = new Promise<EntryResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flushRequest(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
function metadata(): ReturnType<typeof within> {
  return within(screen.getByRole('region', { name: 'Selected item metadata' }))
}

beforeEach(() => {
  vi.resetAllMocks()
  getEntry.mockResolvedValue({ ok: true, value: file })
  vi.stubGlobal('spaceLens', { getScanEntry: getEntry })
})
afterEach(() => vi.unstubAllGlobals())

test.each([
  { scanId: null, selectedEntryId: null },
  { scanId: 'published', selectedEntryId: null },
  { scanId: null, selectedEntryId: 'file' }
])('shows an empty state without requesting invalid selection %o', async (identity) => {
  render(<DetailsPanel {...identity} />)
  await flushRequest()
  expect(screen.getByText('No item selected')).toBeVisible()
  expect(getEntry).not.toHaveBeenCalled()
})

test('loads only the selected entry and shows file metadata with consistent UTC timestamps', async () => {
  render(<DetailsPanel {...props} />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading item details')
  await screen.findByRole('heading', { name: 'report.txt', level: 4 })
  expect(getEntry).toHaveBeenCalledExactlyOnceWith({ scanId: 'published', entryId: 'file' })
  const panel = metadata()
  for (const value of ['file', 'Logical size', '1.5 KB', '/root/report.txt', 'Created', 'Modified'])
    expect(panel.getByText(value)).toBeVisible()
  expect(panel.getByText('1.5 KB')).toHaveAttribute('title', '1,500 bytes')
  expect(panel.getByText(/12:30:00 PM UTC/)).toHaveAttribute('datetime', file.createdAt)
  expect(panel.getByText(/1:30:00 PM UTC/)).toHaveAttribute('datetime', file.modifiedAt)
})

test('shows directory aggregation and unavailable timestamps without inferring metadata', async () => {
  getEntry.mockResolvedValue({ ok: true, value: folder })
  render(<DetailsPanel {...props} selectedEntryId="folder" />)
  await screen.findByRole('heading', { name: 'Documents' })
  expect(metadata().getByText('directory')).toBeVisible()
  expect(metadata().getByText('Aggregated size')).toBeVisible()
  expect(metadata().getByText('2.5 KB')).toBeVisible()
  expect(metadata().getAllByText('Not available')).toHaveLength(2)
  expect(metadata().queryByText('Logical size')).not.toBeInTheDocument()
})

test.each(['file', 'directory'] as const)(
  'distinguishes zero from unknown %s size',
  async (type) => {
    const entry = { ...file, type, sizeBytes: 0, aggregatedSizeBytes: 0 }
    getEntry.mockResolvedValue({ ok: true, value: entry })
    const view = render(<DetailsPanel {...props} />)
    await screen.findByText('0 B')
    view.rerender(<DetailsPanel {...props} selectedEntryId={null} />)
    getEntry.mockResolvedValue({
      ok: true,
      value: { ...entry, sizeBytes: null, aggregatedSizeBytes: null }
    })
    view.rerender(<DetailsPanel {...props} />)
    await screen.findByRole('heading', { name: 'report.txt' })
    expect(metadata().getByText('Not available')).toBeVisible()
    expect(screen.queryByText('0 B')).not.toBeInTheDocument()
  }
)

test.each(['symlink', 'other', 'unknown'] as const)(
  'shows actual %s type without unsupported size or link-target fields',
  async (type) => {
    getEntry.mockResolvedValue({
      ok: true,
      value: { ...file, type, sizeBytes: null, createdAt: null, modifiedAt: 'invalid date' }
    })
    render(<DetailsPanel {...props} />)
    await screen.findByRole('heading', { name: 'report.txt' })
    expect(metadata().getByText(type)).toBeVisible()
    expect(
      metadata().queryByText(/Logical size|Aggregated size|MIME|Target/)
    ).not.toBeInTheDocument()
    expect(metadata().getAllByText('Not available')).toHaveLength(2)
  }
)

test('preserves full long names and paths as readable text', async () => {
  const name = `${'long'.repeat(100)}.txt`
  const path = `/root/${'nested/'.repeat(100)}${name}`
  getEntry.mockResolvedValue({ ok: true, value: { ...file, name, path } })
  render(<DetailsPanel {...props} />)
  expect(await screen.findByRole('heading', { name })).toHaveTextContent(name)
  expect(metadata().getByText(path)).toHaveTextContent(path)
  expect(screen.getByRole('region', { name: 'Selected item metadata' })).toHaveAttribute(
    'tabindex',
    '0'
  )
})

test('unchanged selection avoids duplicate requests during loading and after success, including Strict Mode', async () => {
  const pending = deferred()
  getEntry.mockReturnValue(pending.promise)
  const view = render(
    <StrictMode>
      <DetailsPanel {...props} />
    </StrictMode>
  )
  await flushRequest()
  view.rerender(
    <StrictMode>
      <DetailsPanel {...props} />
    </StrictMode>
  )
  await flushRequest()
  expect(getEntry).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve({ ok: true, value: file }))
  view.rerender(
    <StrictMode>
      <DetailsPanel {...props} />
    </StrictMode>
  )
  await flushRequest()
  expect(getEntry).toHaveBeenCalledTimes(1)
})

test.each(['ENTRY_NOT_FOUND', 'SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE'] as const)(
  'preserves %s and retries the same selected entry',
  async (code) => {
    getEntry.mockResolvedValueOnce({ ok: false, error: { code, message: 'Original failure' } })
    render(<DetailsPanel {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(`${code}: Original failure`)
    expect(screen.queryByText('No item selected')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry item details' }))
    expect(screen.getByRole('status')).toBeVisible()
    await screen.findByRole('heading', { name: 'report.txt' })
    expect(getEntry).toHaveBeenCalledTimes(2)
    expect(getEntry).toHaveBeenLastCalledWith({ scanId: 'published', entryId: 'file' })
  }
)

test('handles transport errors locally and permits retry', async () => {
  getEntry.mockRejectedValueOnce(new Error('Disconnected'))
  render(<DetailsPanel {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'TRANSPORT_ERROR: Entry details could not be loaded.'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry item details' }))
  await screen.findByRole('heading', { name: 'report.txt' })
})

test.each([
  { scanId: 'next', selectedEntryId: 'file' },
  { scanId: 'published', selectedEntryId: 'folder' }
])('ignores out-of-order responses for replaced identity %o', async (identity) => {
  const old = deferred()
  const replacement = { ...folder, scanId: identity.scanId, id: identity.selectedEntryId }
  getEntry.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, value: replacement })
  const view = render(<DetailsPanel {...props} />)
  await flushRequest()
  view.rerender(<DetailsPanel {...identity} />)
  await screen.findByRole('heading', { name: 'Documents' })
  await act(async () => old.resolve({ ok: true, value: file }))
  expect(screen.queryByRole('heading', { name: 'report.txt' })).not.toBeInTheDocument()
  expect(getEntry).toHaveBeenLastCalledWith({
    scanId: identity.scanId,
    entryId: identity.selectedEntryId
  })
})

test('clears loaded metadata immediately and discards failures after clearing or unmounting', async () => {
  const view = render(<DetailsPanel {...props} />)
  await screen.findByRole('heading', { name: 'report.txt' })
  const pending = deferred()
  getEntry.mockReturnValue(pending.promise)
  view.rerender(<DetailsPanel {...props} selectedEntryId="folder" />)
  expect(screen.queryByText('report.txt')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toBeVisible()
  await flushRequest()
  view.rerender(<DetailsPanel {...props} selectedEntryId={null} />)
  await act(async () =>
    pending.resolve({ ok: false, error: { code: 'ENTRY_NOT_FOUND', message: 'Old failure' } })
  )
  expect(screen.getByText('No item selected')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  const last = deferred()
  getEntry.mockReturnValue(last.promise)
  view.rerender(<DetailsPanel {...props} />)
  await flushRequest()
  view.unmount()
  await act(async () => last.resolve({ ok: true, value: file }))
  expect(screen.queryByRole('region', { name: 'Selected item metadata' })).not.toBeInTheDocument()
})

test('rejects metadata belonging to a different entry or snapshot', async () => {
  getEntry.mockResolvedValue({ ok: true, value: { ...folder, scanId: 'old' } })
  render(<DetailsPanel {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('INVALID_REQUEST')
  expect(screen.queryByRole('heading', { name: 'Documents' })).not.toBeInTheDocument()
})

function mountExplorer(): {
  getSnapshot: ReturnType<typeof vi.fn<SpaceLensAPI['getScanSnapshot']>>
} {
  const getSnapshot = vi.fn<SpaceLensAPI['getScanSnapshot']>().mockResolvedValue({
    ok: true,
    value: { snapshot, unavailable: { scanId: 'summary-only', reason: 'limit-exceeded' } }
  })
  getEntry.mockImplementation(async ({ entryId }) => ({
    ok: true,
    value: entryId === 'file' ? file : folder
  }))
  vi.stubGlobal('spaceLens', {
    getScanSnapshot: getSnapshot,
    getScanEntry: getEntry,
    getScanDirectoryTreemap: vi.fn<SpaceLensAPI['getScanDirectoryTreemap']>(
      async ({ scanId, entryId }) => ({
        ok: true,
        value: treemapSummary(
          entryId === 'root' ? [file, folder].map((entry) => ({ ...entry, scanId })) : [],
          { scanId, directoryId: entryId }
        )
      })
    ),
    listScanDirectory: vi
      .fn<SpaceLensAPI['listScanDirectory']>()
      .mockImplementation(async ({ scanId, entryId, offset }) => ({
        ok: true,
        value: {
          scanId,
          directoryId: entryId,
          entries:
            entryId === 'root'
              ? offset === 0
                ? [file, folder]
                : [{ ...file, id: 'last', name: 'Last file' }]
              : [],
          totalCount: entryId === 'root' ? 101 : 0,
          nextOffset: entryId === 'root' && offset === 0 ? 100 : null
        }
      }))
  })
  render(<ExplorerPage />)
  return { getSnapshot }
}

test('table selection updates details; directory navigation, history and tree navigation clear them', async () => {
  mountExplorer()
  const details = within(screen.getByRole('region', { name: 'Details' }))
  const contents = within(screen.getByRole('region', { name: 'Directory Contents' }))
  expect(details.getByText('No item selected')).toBeVisible()
  fireEvent.click(await contents.findByRole('button', { name: 'report.txt' }))
  await details.findByRole('heading', { name: 'report.txt' })
  fireEvent.click(contents.getByRole('button', { name: 'Documents' }))
  await details.findByText('2.5 KB')
  expect(details.queryByRole('heading', { name: 'report.txt' })).not.toBeInTheDocument()
  fireEvent.doubleClick(contents.getByRole('button', { name: 'Documents' }))
  await contents.findByText('This directory is empty.')
  expect(details.getByText('No item selected')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await contents.findByRole('button', { name: 'report.txt' })
  fireEvent.click(contents.getByRole('button', { name: 'report.txt' }))
  await details.findByRole('heading', { name: 'report.txt' })
  fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
  await contents.findByText('This directory is empty.')
  expect(details.getByText('No item selected')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Up' }))
  await contents.findByRole('button', { name: 'report.txt' })
  fireEvent.click(contents.getByRole('button', { name: 'report.txt' }))
  await details.findByRole('heading', { name: 'report.txt' })
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  const tree = within(screen.getByRole('region', { name: 'Directory Tree' }))
  fireEvent.click(await tree.findByRole('button', { name: 'Documents' }))
  await contents.findByText('This directory is empty.')
  expect(details.getByText('No item selected')).toBeVisible()
})

test('page changes and snapshot replacement clear details using shared Explorer selection', async () => {
  const { getSnapshot } = mountExplorer()
  const details = within(screen.getByRole('region', { name: 'Details' }))
  const contents = within(screen.getByRole('region', { name: 'Directory Contents' }))
  fireEvent.click(await contents.findByRole('button', { name: 'report.txt' }))
  await details.findByRole('heading', { name: 'report.txt' })
  expect(getEntry).toHaveBeenLastCalledWith({ scanId: 'published', entryId: 'file' })
  fireEvent.click(contents.getByRole('button', { name: 'Next page' }))
  await contents.findByRole('button', { name: 'Last file' })
  expect(details.getByText('No item selected')).toBeVisible()
  fireEvent.click(contents.getByRole('button', { name: 'Previous page' }))
  fireEvent.click(await contents.findByRole('button', { name: 'report.txt' }))
  await details.findByRole('heading', { name: 'report.txt' })
  getSnapshot.mockResolvedValue({
    ok: true,
    value: {
      snapshot: {
        ...snapshot,
        entries: { scanId: 'replacement', rootEntryId: 'root' },
        root: { ...root, scanId: 'replacement' }
      },
      unavailable: null
    }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }))
  await details.findByText('No item selected')
  expect(details.queryByRole('heading', { name: 'report.txt' })).not.toBeInTheDocument()
})
