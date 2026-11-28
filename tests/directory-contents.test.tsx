import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import type { FileEntry } from '../src/shared/scan'
import { treemapSummary } from './treemap-fixtures'
import { DirectoryContentsTable } from '../src/renderer/src/features/explorer/DirectoryContentsTable'
import App from '../src/renderer/src/App'
import { mockSnapshotSelection } from './snapshot-selection-fixture'
import { recentHistoryPage } from './recent-scans-fixture'
const list = vi.fn<SpaceLensAPI['listScanDirectory']>()
const select = vi.fn<(id: string | null) => void>()
const navigate = vi.fn<(id: string) => Promise<void>>()
const file: FileEntry = {
  id: 'file',
  scanId: 'scan',
  parentId: 'root',
  name: 'zero.txt',
  path: '/root/zero.txt',
  type: 'file',
  sizeBytes: 0,
  aggregatedSizeBytes: null,
  createdAt: null,
  modifiedAt: null
}
const folder: FileEntry = {
  ...file,
  id: 'folder',
  name: 'Folder',
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 1500
}
function response(
  entries: FileEntry[],
  nextOffset: number | null = null,
  totalCount = entries.length
): Awaited<ReturnType<SpaceLensAPI['listScanDirectory']>> {
  return {
    ok: true,
    value: { scanId: 'scan', directoryId: 'root', entries, nextOffset, totalCount }
  }
}
const props = {
  scanId: 'scan',
  directoryId: 'root',
  selectedEntryId: null,
  onSelect: select,
  onNavigate: navigate
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('spaceLens', { listScanDirectory: list })
  list.mockResolvedValue(response([file, folder]))
})
afterEach(() => vi.unstubAllGlobals())
test('renders ordered metadata, zero and unavailable sizes with bounded first-page access', async () => {
  list.mockResolvedValue(
    response([
      file,
      folder,
      { ...file, id: 'unknown', name: 'Unknown', type: 'unknown', sizeBytes: null }
    ])
  )
  render(<DirectoryContentsTable {...props} />)
  await screen.findByText('zero.txt')
  expect(screen.getByText('0 B')).toBeVisible()
  expect(screen.getByText('1.5 KB')).toBeVisible()
  expect(screen.getByLabelText('Size unavailable')).toBeVisible()
  expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual([
    'Name',
    'Type',
    'Size'
  ])
  expect(list).toHaveBeenCalledExactlyOnceWith({
    scanId: 'scan',
    entryId: 'root',
    offset: 0,
    limit: 100
  })
  expect(
    screen
      .getAllByRole('row')
      .slice(1)
      .map((el) => within(el).getByRole('button').textContent)
  ).toEqual(['zero.txt', 'Folder', 'Unknown'])
})
test('single click selects, Enter/double click open directories, files never open', async () => {
  const view = render(<DirectoryContentsTable {...props} />)
  const name = await screen.findByRole('button', { name: 'Folder' })
  fireEvent.click(name)
  expect(select).toHaveBeenLastCalledWith('folder')
  expect(navigate).not.toHaveBeenCalled()
  view.rerender(<DirectoryContentsTable {...props} selectedEntryId="folder" />)
  expect(name).toHaveAttribute('aria-pressed', 'true')
  fireEvent.keyDown(name, { key: 'Enter' })
  fireEvent.doubleClick(name)
  expect(navigate).toHaveBeenCalledTimes(2)
  fireEvent.doubleClick(screen.getByRole('button', { name: 'zero.txt' }))
  fireEvent.keyDown(screen.getByRole('button', { name: 'zero.txt' }), { key: 'Enter' })
  expect(navigate).toHaveBeenCalledTimes(2)
})
test('explicit pagination clears selection, respects nextOffset and retains just one page', async () => {
  list
    .mockResolvedValueOnce(response([file], 100, 101))
    .mockResolvedValueOnce(response([folder], null, 101))
    .mockResolvedValueOnce(response([file], 100, 101))
  render(<DirectoryContentsTable {...props} selectedEntryId="file" />)
  await screen.findByText('zero.txt')
  const next = screen.getByRole('button', { name: 'Next page' })
  next.focus()
  fireEvent.click(next)
  expect(next).toHaveFocus()
  await screen.findByText('Folder')
  expect(select).toHaveBeenCalledWith(null)
  expect(screen.queryByText('zero.txt')).not.toBeInTheDocument()
  expect(screen.getByText('Page 2 of 2 · 101 entries')).toBeVisible()
  expect(next).toHaveAttribute('aria-disabled', 'true')
  expect(next).toHaveFocus()
  fireEvent.click(next)
  expect(list).toHaveBeenCalledTimes(2)
  expect(list).toHaveBeenLastCalledWith({
    scanId: 'scan',
    entryId: 'root',
    offset: 100,
    limit: 100
  })
  fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
  await screen.findByText('zero.txt')
  expect(list).toHaveBeenCalledTimes(3)
})
test.each(['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE', 'ENTRY_NOT_FOUND'] as const)(
  'offers the appropriate recovery for %s without claiming emptiness',
  async (code) => {
    list
      .mockResolvedValueOnce({ ok: false, error: { code, message: 'Original message' } })
      .mockResolvedValueOnce(response([]))
    const refresh = vi.fn()
    render(<DirectoryContentsTable {...props} onRefresh={refresh} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(`${code}: Original message`)
    expect(screen.queryByText('This directory is empty.')).not.toBeInTheDocument()
    if (code === 'ENTRY_NOT_FOUND') {
      fireEvent.click(screen.getByText('Retry directory contents'))
      await screen.findByText('This directory is empty.')
    } else {
      expect(screen.getByRole('alert')).toHaveTextContent('Use Refresh snapshot')
      fireEvent.click(
        screen.getByRole('button', { name: 'Refresh snapshot for Directory Contents' })
      )
      expect(refresh).toHaveBeenCalledOnce()
      expect(list).toHaveBeenCalledOnce()
    }
  }
)
test('transport failure on subsequent page keeps previous rows and retries that offset', async () => {
  list
    .mockResolvedValueOnce(response([file], 100, 101))
    .mockRejectedValueOnce(new Error('failure'))
    .mockResolvedValueOnce(response([folder]))
  render(<DirectoryContentsTable {...props} />)
  await screen.findByText('zero.txt')
  fireEvent.click(screen.getByText('Next'))
  expect(await screen.findByRole('alert')).toHaveTextContent('TRANSPORT_ERROR')
  expect(screen.getByText('zero.txt')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'zero.txt' }))
  expect(select).toHaveBeenLastCalledWith('file')
  fireEvent.click(screen.getByText('Retry directory contents'))
  await screen.findByText('Folder')
  expect(select).toHaveBeenLastCalledWith(null)
  expect(list).toHaveBeenLastCalledWith({
    scanId: 'scan',
    entryId: 'root',
    offset: 100,
    limit: 100
  })
})
test.each([
  { scanId: 'next', directoryId: 'root' },
  { scanId: 'scan', directoryId: 'other' }
])('ignores old responses after identity change %o', async (identity) => {
  let resolve!: (value: Awaited<ReturnType<SpaceLensAPI['listScanDirectory']>>) => void
  list
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    .mockResolvedValueOnce(response([folder]))
  const view = render(<DirectoryContentsTable {...props} />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading')
  await act(async () => {
    await Promise.resolve()
  })
  view.rerender(<DirectoryContentsTable {...props} {...identity} />)
  await screen.findByText('Folder')
  await act(async () => resolve(response([file])))
  expect(screen.queryByText('zero.txt')).not.toBeInTheDocument()
  expect(list).toHaveBeenLastCalledWith({
    scanId: identity.scanId,
    entryId: identity.directoryId,
    offset: 0,
    limit: 100
  })
})
test('unavailable snapshots make no requests', () => {
  render(<DirectoryContentsTable {...props} scanId={null} directoryId={null} />)
  expect(list).not.toHaveBeenCalled()
  expect(screen.getByText('No directory contents to display')).toBeVisible()
})

test('table navigation synchronizes breadcrumbs, history and visible tree highlighting', async () => {
  const root = { ...folder, id: 'root', name: 'Root', parentId: null }
  const getScanSnapshot = vi.fn<SpaceLensAPI['getScanSnapshot']>(async () => ({
    ok: true,
    value: {
      snapshot: {
        entries: { scanId: 'scan', rootEntryId: 'root' },
        root,
        completedAt: '2026-11-16T00:00:00Z',
        entryCount: 3,
        incomplete: false,
        summary: { fileCount: 1, directoryCount: 2, totalBytes: 1500, errorCount: 0 }
      },
      unavailable: null
    }
  }))
  vi.stubGlobal('spaceLens', {
    listScanDirectory: list,
    getScanDirectoryTreemap: async ({ scanId, entryId }: { scanId: string; entryId: string }) => ({
      ok: true,
      value: treemapSummary(entryId === 'root' ? [file, folder] : [], {
        scanId,
        directoryId: entryId
      })
    }),
    getScanState: vi.fn(async () => ({ ok: true, value: { revision: 0, state: null } })),
    getStorageDevices: vi.fn(async () => ({ ok: true, value: [] })),
    listScanHistory: vi.fn(async () => ({ ok: true, value: recentHistoryPage() })),
    onScanStateChanged: vi.fn(() => () => {}),
    getScanSnapshot,
    ...mockSnapshotSelection(getScanSnapshot),
    getScanEntry: vi.fn(async () => ({ ok: true, value: folder }))
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  list.mockImplementation(async ({ entryId }) => response(entryId === 'root' ? [file, folder] : []))
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Explorer' }))
  await screen.findByText('zero.txt')
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  const tree = within(screen.getByRole('region', { name: 'Directory Tree' }))
  await tree.findByRole('button', { name: 'Folder' })
  const contents = within(screen.getByRole('region', { name: 'Directory Contents' }))
  const directory = contents.getByRole('button', { name: 'Folder' })
  directory.focus()
  fireEvent.keyDown(directory, { key: 'Enter' })
  await screen.findByText('This directory is empty.')
  expect(contents.getByRole('group', { name: 'Contents panel' })).toHaveFocus()
  expect(tree.getByRole('button', { name: 'Folder' })).toHaveAttribute('aria-current', 'location')
  expect(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Folder')
  ).toHaveAttribute('aria-current', 'page')
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await screen.findByText('zero.txt')
  fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
  await screen.findByText('This directory is empty.')
  fireEvent.click(screen.getByRole('button', { name: 'Up' }))
  await screen.findByText('zero.txt')
})
