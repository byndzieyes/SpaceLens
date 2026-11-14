import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DirectoryTree } from '../src/renderer/src/features/explorer/DirectoryTree'
import type { FileEntry } from '../src/shared/scan'
import type { ScanSnapshot } from '../src/shared/snapshot'
import type { SpaceLensAPI } from '../src/shared/ipc'
const root: FileEntry = {
  id: 'root',
  scanId: 'scan',
  parentId: null,
  name: 'Root',
  path: '/root',
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 0,
  createdAt: null,
  modifiedAt: null
}
const child: FileEntry = {
  ...root,
  id: 'child',
  parentId: 'root',
  name: 'Child',
  path: '/root/Child'
}
const snapshot: ScanSnapshot = {
  entries: { scanId: 'scan', rootEntryId: 'root' },
  root,
  completedAt: '2026-11-14T00:00:00Z',
  entryCount: 3,
  incomplete: false,
  summary: { fileCount: 1, directoryCount: 2, totalBytes: 0, errorCount: 0 }
}
const list = vi.fn<SpaceLensAPI['listScanDirectory']>()
const navigate = vi.fn<(id: string) => Promise<void>>()
function page(
  entries: FileEntry[],
  nextOffset: number | null = null
): Awaited<ReturnType<SpaceLensAPI['listScanDirectory']>> {
  return {
    ok: true as const,
    value: {
      scanId: 'scan',
      directoryId: 'root',
      entries,
      nextOffset,
      totalCount: nextOffset === null ? entries.length : 201
    }
  }
}
function mount(): ReturnType<typeof render> {
  return render(
    <DirectoryTree snapshot={snapshot} currentDirectoryId="root" onNavigate={navigate} />
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('spaceLens', { listScanDirectory: list })
  list.mockResolvedValue(page([child]))
})
afterEach(() => vi.unstubAllGlobals())
test('loads only on expansion, filters files and preserves separate navigation', async () => {
  list.mockResolvedValue(page([{ ...child, id: 'file', type: 'file', name: 'file.txt' }, child]))
  mount()
  expect(list).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Root' })).toHaveAttribute('aria-current', 'location')
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  await screen.findByRole('button', { name: 'Child' })
  expect(screen.queryByText('file.txt')).not.toBeInTheDocument()
  expect(navigate).not.toHaveBeenCalled()
  expect(list).toHaveBeenCalledExactlyOnceWith({
    scanId: 'scan',
    entryId: 'root',
    offset: 0,
    limit: 100
  })
  fireEvent.click(screen.getByRole('button', { name: 'Child' }))
  expect(navigate).toHaveBeenCalledWith('child')
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Root' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  expect(list).toHaveBeenCalledTimes(1)
})
test('file-only pages retain explicit next/previous paging without accumulation', async () => {
  list
    .mockResolvedValueOnce(page([], 100))
    .mockResolvedValueOnce(page([child], 200))
    .mockResolvedValueOnce(page([], 100))
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  await screen.findByText(/More entries are available/)
  expect(screen.queryByText('No subdirectories')).not.toBeInTheDocument()
  expect(list).toHaveBeenCalledTimes(1)
  fireEvent.click(within(screen.getByRole('group', { name: 'Pages for Root' })).getByText('Next'))
  await screen.findByRole('button', { name: 'Child' })
  expect(list).toHaveBeenLastCalledWith({
    scanId: 'scan',
    entryId: 'root',
    offset: 100,
    limit: 100
  })
  fireEvent.click(screen.getByText('Previous'))
  await screen.findByText(/More entries are available/)
  expect(screen.queryByRole('button', { name: 'Child' })).not.toBeInTheDocument()
})
test('reports complete empty listings and structured failures separately and retries', async () => {
  list
    .mockResolvedValueOnce({ ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired' } })
    .mockResolvedValueOnce(page([]))
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('SNAPSHOT_EXPIRED: Expired')
  expect(screen.queryByText('No subdirectories')).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('Retry Root'))
  await screen.findByText('No subdirectories')
})
test('deduplicates pending expansion and ignores old-snapshot responses', async () => {
  let finish!: (value: Awaited<ReturnType<SpaceLensAPI['listScanDirectory']>>) => void
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Root' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  expect(list).toHaveBeenCalledTimes(1)
  view.rerender(
    <DirectoryTree
      snapshot={{
        ...snapshot,
        entries: { scanId: 'next', rootEntryId: 'root' },
        root: { ...root, scanId: 'next' }
      }}
      currentDirectoryId="root"
      onNavigate={navigate}
    />
  )
  await act(async () => finish(page([child])))
  expect(screen.queryByText('Child')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Expand Root' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
})
test('failed page changes retain directories and retry the requested offset', async () => {
  list
    .mockResolvedValueOnce(page([child], 100))
    .mockRejectedValueOnce(new Error('transport'))
    .mockResolvedValueOnce(page([]))
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  await screen.findByText('Child')
  fireEvent.click(screen.getByText('Next'))
  await screen.findByRole('alert')
  expect(screen.getByText('Child')).toBeVisible()
  fireEvent.click(screen.getByText('Retry Root'))
  await screen.findByText('No directories on this page.')
  expect(list).toHaveBeenLastCalledWith({
    scanId: 'scan',
    entryId: 'root',
    offset: 100,
    limit: 100
  })
})

test('nested nodes load independently and collapse releases descendants', async () => {
  list
    .mockResolvedValueOnce(page([child]))
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce(page([]))
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  await screen.findByText('Child')
  fireEvent.click(screen.getByRole('button', { name: 'Expand Child' }))
  await screen.findByText('No subdirectories')
  expect(list).toHaveBeenLastCalledWith({ scanId: 'scan', entryId: 'child', offset: 0, limit: 100 })
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Root' }))
  expect(list).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  expect(screen.getByRole('button', { name: 'Expand Child' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  expect(list).toHaveBeenCalledTimes(2)
})

test('navigation updates highlight without resetting expansion or loading more pages', async () => {
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  await screen.findByText('Child')
  view.rerender(
    <DirectoryTree snapshot={snapshot} currentDirectoryId="child" onNavigate={navigate} />
  )
  expect(screen.getByRole('button', { name: 'Child' })).toHaveAttribute('aria-current', 'location')
  expect(screen.getByRole('button', { name: 'Collapse Root' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  expect(list).toHaveBeenCalledTimes(1)
})

test('caps retained pages and makes capacity available after collapsing a branch', async () => {
  const children = Array.from({ length: 32 }, (_, i) => ({
    ...child,
    id: `d${i}`,
    name: `Directory ${i}`
  }))
  list.mockResolvedValueOnce(page(children)).mockResolvedValue(page([]))
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  await screen.findByText('Directory 0')
  for (let i = 0; i < 31; i++) {
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: `Expand Directory ${i}` }))
    )
  }
  fireEvent.click(screen.getByRole('button', { name: 'Expand Directory 31' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Tree page limit reached')
  expect(list).toHaveBeenCalledTimes(32)
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Root' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Expand Directory 31' }))
  )
  expect(list).toHaveBeenCalledTimes(33)
})
