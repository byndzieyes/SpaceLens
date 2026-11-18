import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import type { ScanSnapshot } from '../src/shared/snapshot'
import { DirectoryTreemap } from '../src/renderer/src/features/explorer/DirectoryTreemap'
import { Treemap } from '../src/renderer/src/features/explorer/Treemap'
import { createTreemapData } from '../src/renderer/src/features/explorer/treemapData'
import * as treemapLayout from '../src/renderer/src/features/explorer/treemapLayout'
import { ExplorerPage } from '../src/renderer/src/pages/ExplorerPage'
import {
  treemapFile as file,
  treemapFolder as folder,
  treemapRoot as root,
  treemapPage as page
} from './treemap-fixtures'

const list = vi.fn<SpaceLensAPI['listScanDirectory']>()
const onSelect = vi.fn<(id: string) => void>()
const onNavigate = vi.fn<(id: string) => Promise<void>>()
const interactions = { selectedEntryId: null, onSelect, onNavigate }
const props = { scanId: 'published', directory: root, ...interactions }
type PageResult = Awaited<ReturnType<SpaceLensAPI['listScanDirectory']>>
function deferred(): { promise: Promise<PageResult>; resolve: (result: PageResult) => void } {
  let resolve!: (result: PageResult) => void
  const promise = new Promise<PageResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ResizeObserver', undefined)
  vi.stubGlobal('spaceLens', { listScanDirectory: list })
  list.mockResolvedValue({ ok: true, value: page() })
})
afterEach(() => vi.unstubAllGlobals())

test('renders labeled native controls over SVG with clipped labels and an accessible summary', () => {
  const name = 'long-name-'.repeat(200)
  const { container } = render(
    <Treemap {...interactions} data={createTreemapData(root, [{ ...file, name }, folder])} />
  )
  const figure = screen.getByRole('figure', { name: 'Storage distribution in Root' })
  expect(figure).toHaveAccessibleDescription(
    /Rectangle area represents known logical storage size of direct children/
  )
  expect(container.querySelectorAll('svg g[data-entry-id]')).toHaveLength(2)
  expect(container.querySelectorAll('svg text')).toHaveLength(2)
  for (const text of container.querySelectorAll('svg text'))
    expect(text).toHaveAttribute('clip-path')
  expect(container.querySelector('svg text')?.textContent).toContain('Documents')
  expect(container.querySelectorAll('clipPath')).toHaveLength(2)
  expect(within(figure).getByRole('button', { name: `${name}, file, 1 KB` })).toBeVisible()
  expect(within(figure).getByRole('button', { name: 'Documents, directory, 3 KB' })).toBeVisible()
  expect(
    within(screen.getByRole('list', { name: 'Treemap entry sizes' })).getByText(
      `${name}, file: 1 KB`
    )
  ).toBeInTheDocument()
  expect(container.querySelectorAll('svg [role="button"]')).toHaveLength(0)
})

test('omits labels for tiny rectangles while retaining their names in the accessible summary', () => {
  const { container } = render(
    <Treemap
      {...interactions}
      data={createTreemapData(root, [
        { ...file, sizeBytes: 1, name: 'tiny.txt' },
        { ...folder, aggregatedSizeBytes: 1000000 }
      ])}
    />
  )
  expect(container.querySelector('[data-entry-id="file"] text')).toBeNull()
  expect(container.querySelector('[data-entry-id="folder"] text')).not.toBeNull()
  expect(screen.getByText('tiny.txt, file: 1 B')).toBeInTheDocument()
})

test('uses entry IDs for activation and highlighting even when names match', () => {
  const duplicate = { ...file, id: 'second-file' }
  const data = createTreemapData(root, [file, duplicate])
  const view = render(<Treemap {...interactions} data={data} selectedEntryId={duplicate.id} />)
  const tiles = screen.getAllByRole('button', { name: 'report.txt, file, 1 KB' })
  const selected = screen.getByRole('button', { name: 'report.txt, file, 1 KB', pressed: true })
  const other = tiles.find((tile) => tile !== selected)!
  fireEvent.click(selected)
  expect(onSelect).toHaveBeenLastCalledWith(duplicate.id)
  fireEvent.click(other)
  expect(onSelect).toHaveBeenLastCalledWith(file.id)
  expect(other).toHaveAttribute('aria-pressed', 'false')
  view.rerender(<Treemap {...interactions} data={data} />)
  expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument()
  expect(onNavigate).not.toHaveBeenCalled()
})

test('hover and focus expose existing metadata without selecting, fetching, or laying out again', async () => {
  const calculate = vi.spyOn(treemapLayout, 'calculateTreemap')
  const view = render(<DirectoryTreemap {...props} selectedEntryId={file.id} />)
  const folderTile = await screen.findByRole('button', { name: 'Documents, directory, 3 KB' })
  const fileTile = screen.getByRole('button', { name: 'report.txt, file, 1 KB' })
  const information = within(screen.getByRole('group', { name: 'Treemap entry information' }))
  const layoutCalls = calculate.mock.calls.length
  expect(layoutCalls).toBeGreaterThan(0)

  fireEvent.pointerEnter(folderTile)
  expect(information.getByText('Documents')).toBeVisible()
  expect(information.getByText(/directory.*Aggregated size:\s*3 KB/)).toBeVisible()
  expect(folderTile).toHaveAttribute('aria-pressed', 'false')
  expect(fileTile).toHaveAttribute('aria-pressed', 'true')
  fireEvent.pointerLeave(folderTile)
  expect(information.queryByText(/Aggregated size/)).not.toBeInTheDocument()

  act(() => fileTile.focus())
  expect(fileTile).toHaveFocus()
  expect(information.getByText('report.txt')).toBeVisible()
  expect(information.getByText(/file.*Logical size:\s*1 KB/)).toBeVisible()
  act(() => fileTile.blur())
  expect(information.queryByText(/Logical size/)).not.toBeInTheDocument()

  view.rerender(<DirectoryTreemap {...props} selectedEntryId={folder.id} />)
  expect(folderTile).toHaveAttribute('aria-pressed', 'true')
  expect(fileTile).toHaveAttribute('aria-pressed', 'false')
  expect(calculate).toHaveBeenCalledTimes(layoutCalls)
  expect(list).toHaveBeenCalledOnce()
  expect(onSelect).not.toHaveBeenCalled()
  expect(onNavigate).not.toHaveBeenCalled()
})

test('Space selects without scrolling and only directory activation can navigate', () => {
  render(<Treemap {...interactions} data={createTreemapData(root, [file, folder])} />)
  const fileTile = screen.getByRole('button', { name: 'report.txt, file, 1 KB' })
  const folderTile = screen.getByRole('button', { name: 'Documents, directory, 3 KB' })

  act(() => fileTile.focus())
  expect(fireEvent.keyDown(fileTile, { key: ' ', code: 'Space' })).toBe(false)
  expect(onSelect).toHaveBeenLastCalledWith(file.id)
  onSelect.mockClear()
  expect(fireEvent.keyDown(fileTile, { key: 'Enter' })).toBe(false)
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(file.id)
  fireEvent.doubleClick(fileTile)
  expect(onNavigate).not.toHaveBeenCalled()

  act(() => folderTile.focus())
  fireEvent.click(folderTile)
  expect(onSelect).toHaveBeenLastCalledWith(folder.id)
  expect(onNavigate).not.toHaveBeenCalled()
  expect(fireEvent.keyDown(folderTile, { key: 'Enter' })).toBe(false)
  expect(onNavigate).toHaveBeenNthCalledWith(1, folder.id)
  fireEvent.doubleClick(folderTile)
  expect(onNavigate).toHaveBeenNthCalledWith(2, folder.id)
})

test('blocks navigation and selection while Explorer is busy', () => {
  render(<Treemap {...interactions} disabled data={createTreemapData(root, [folder])} />)
  const tile = screen.getByRole('button', { name: 'Documents, directory, 3 KB' })
  expect(tile).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(tile)
  fireEvent.doubleClick(tile)
  fireEvent.keyDown(tile, { key: ' ' })
  fireEvent.keyDown(tile, { key: 'Enter' })
  expect(onSelect).not.toHaveBeenCalled()
  expect(onNavigate).not.toHaveBeenCalled()
})

test('resizing clears information for tiles that disappear, without requesting data', () => {
  let resize!: ResizeObserverCallback
  const disconnect = vi.fn()
  const observe = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe = observe
      disconnect = disconnect
    }
  )
  const { container, unmount } = render(
    <Treemap
      {...interactions}
      data={createTreemapData(root, [{ ...file, sizeBytes: 12 }, folder])}
    />
  )
  const tileName = 'report.txt, file, 12 B'
  const smallTile = screen.getByRole('button', { name: tileName })
  const information = within(screen.getByRole('group', { name: 'Treemap entry information' }))
  act(() => smallTile.focus())
  fireEvent.pointerEnter(smallTile)
  expect(information.getByText('report.txt')).toBeVisible()
  for (const width of [280, 400, 900, 1280]) {
    act(() =>
      resize([{ contentRect: { width, height: 320 } } as ResizeObserverEntry], {} as ResizeObserver)
    )
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', `0 0 ${width} 320`)
    expect(information.queryByText('report.txt')).not.toBeInTheDocument()
    if (width === 280) expect(screen.queryByRole('button', { name: tileName })).toBeNull()
  }
  expect(screen.getByRole('button', { name: tileName })).toBeVisible()
  expect(observe).toHaveBeenCalledOnce()
  expect(list).not.toHaveBeenCalled()
  unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})

test('loads one complete page with actual published scan ID and no entry-detail or recursive requests', async () => {
  render(<DirectoryTreemap {...props} />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading treemap')
  await screen.findByRole('figure')
  expect(list).toHaveBeenCalledExactlyOnceWith({
    scanId: 'published',
    entryId: 'root',
    offset: 0,
    limit: 100
  })
})

test.each([
  page([file], { totalCount: 101, nextOffset: 100 }),
  page([file], { totalCount: 101, nextOffset: null }),
  page([file], { totalCount: 2, nextOffset: 1 }),
  page([file], { totalCount: 2, nextOffset: null })
])('never renders an incomplete page or loads additional pages (%o)', async (value) => {
  list.mockResolvedValue({ ok: true, value })
  render(<DirectoryTreemap {...props} />)
  expect(await screen.findByText(/Large directories are not supported yet/)).toBeVisible()
  expect(screen.queryByRole('figure')).not.toBeInTheDocument()
  expect(list).toHaveBeenCalledTimes(1)
})

test('exactly 100 direct entries are supported when pagination metadata is complete', async () => {
  list.mockResolvedValue({
    ok: true,
    value: page(Array.from({ length: 100 }, (_, i) => ({ ...file, id: `file-${i}` })))
  })
  const { container } = render(<DirectoryTreemap {...props} />)
  await screen.findByRole('figure')
  expect(container.querySelectorAll('svg g[data-entry-id]')).toHaveLength(100)
  expect(list).toHaveBeenCalledTimes(1)
})

test.each([
  { scanId: null, directory: null },
  { scanId: null, directory: root },
  { scanId: 'published', directory: null }
])('unavailable snapshot or directory %o makes no requests', async (identity) => {
  render(<DirectoryTreemap {...interactions} {...identity} />)
  await flush()
  expect(screen.getByText(/No treemap available/)).toBeVisible()
  expect(list).not.toHaveBeenCalled()
})

test('distinguishes empty, zero-total, unknown-only, and mixed known/unknown size states', async () => {
  list.mockResolvedValueOnce({ ok: true, value: page([]) })
  const view = render(<DirectoryTreemap {...props} />)
  await screen.findByText('This directory is empty. No treemap to display.')
  for (const entries of [
    [{ ...file, sizeBytes: 0 }],
    [{ ...file, sizeBytes: null }],
    [file, { ...folder, aggregatedSizeBytes: null }, { ...file, id: 'zero', sizeBytes: 0 }]
  ]) {
    view.rerender(<DirectoryTreemap {...interactions} scanId={null} directory={null} />)
    list.mockResolvedValueOnce({ ok: true, value: page(entries) })
    view.rerender(<DirectoryTreemap {...props} />)
    await flush()
    if (entries[0].sizeBytes === 0) {
      expect(screen.getByText('1 entries have a known size of 0 B.')).toBeVisible()
      expect(screen.queryByText(/Sizes unavailable/)).not.toBeInTheDocument()
    } else if (entries[0].sizeBytes === null) {
      expect(screen.getByText('No sizes available for this directory.')).toBeVisible()
      expect(screen.getByText(/Sizes unavailable or invalid for 1 entries/)).toBeVisible()
    } else {
      expect(screen.getByRole('figure')).toBeVisible()
      expect(screen.getAllByRole('button')).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'report.txt, file, 1 KB' })).toBeVisible()
      expect(screen.getByText(/Sizes unavailable or invalid for 1 entries; excluded/)).toBeVisible()
      expect(screen.getByText(/1 zero-byte entries have no area/)).toBeVisible()
    }
  }
})

test.each(['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE', 'ENTRY_NOT_FOUND'] as const)(
  'preserves %s and retries without claiming an empty directory',
  async (code) => {
    list.mockResolvedValueOnce({ ok: false, error: { code, message: 'Original error' } })
    render(<DirectoryTreemap {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(`${code}: Original error`)
    expect(screen.queryByText(/This directory is empty/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry treemap' }))
    await screen.findByRole('figure')
    expect(list).toHaveBeenCalledTimes(2)
  }
)

test('transport failures are recoverable and invalid page identity does not produce a chart', async () => {
  list
    .mockRejectedValueOnce(new Error('Disconnected'))
    .mockResolvedValueOnce({ ok: true, value: page([], { directoryId: 'wrong' }) })
  render(<DirectoryTreemap {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('TRANSPORT_ERROR')
  fireEvent.click(screen.getByRole('button', { name: 'Retry treemap' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('INVALID_REQUEST')
  expect(screen.queryByRole('figure')).not.toBeInTheDocument()
})

test.each([
  { scanId: 'next', directory: { ...root, scanId: 'next' } },
  { scanId: 'published', directory: folder }
])('ignores responses for replaced directory or snapshot %o', async (identity) => {
  const old = deferred()
  list.mockReturnValueOnce(old.promise)
  list.mockResolvedValueOnce({
    ok: true,
    value: page([], { scanId: identity.scanId, directoryId: identity.directory.id })
  })
  const view = render(<DirectoryTreemap {...props} />)
  await flush()
  view.rerender(<DirectoryTreemap {...interactions} {...identity} />)
  await screen.findByText('This directory is empty. No treemap to display.')
  await act(async () => old.resolve({ ok: true, value: page() }))
  expect(screen.queryByRole('figure')).not.toBeInTheDocument()
  expect(list).toHaveBeenLastCalledWith({
    scanId: identity.scanId,
    entryId: identity.directory.id,
    offset: 0,
    limit: 100
  })
})

test('unchanged identity has no duplicate concurrent requests in Strict Mode and stale unmounted errors are ignored', async () => {
  const old = deferred()
  list.mockReturnValue(old.promise)
  const view = render(
    <StrictMode>
      <DirectoryTreemap {...props} />
    </StrictMode>
  )
  await flush()
  view.rerender(
    <StrictMode>
      <DirectoryTreemap {...props} />
    </StrictMode>
  )
  await flush()
  expect(list).toHaveBeenCalledOnce()
  view.unmount()
  await act(async () =>
    old.resolve({ ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Old' } })
  )
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('a replaced snapshot clears a hovered selection and disconnects the old tile', async () => {
  const view = render(<DirectoryTreemap {...props} selectedEntryId={folder.id} />)
  const oldTile = await screen.findByRole('button', { name: 'Documents, directory, 3 KB' })
  fireEvent.pointerEnter(oldTile)
  expect(screen.getByText(/Aggregated size/)).toBeVisible()
  expect(oldTile).toHaveAttribute('aria-pressed', 'true')

  const nextFile = { ...file, scanId: 'next' }
  list.mockResolvedValue({ ok: true, value: page([nextFile], { scanId: 'next' }) })
  view.rerender(
    <DirectoryTreemap {...interactions} scanId="next" directory={{ ...root, scanId: 'next' }} />
  )
  expect(oldTile).not.toBeInTheDocument()
  const tile = await screen.findByRole('button', { name: 'report.txt, file, 1 KB' })
  expect(tile).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByText(/Aggregated size/)).not.toBeInTheDocument()
  fireEvent.click(oldTile)
  fireEvent.doubleClick(oldTile)
  expect(onSelect).not.toHaveBeenCalled()
  expect(onNavigate).not.toHaveBeenCalled()
})

test('Explorer shares Treemap selection and navigation with Contents, Details, breadcrumbs and history', async () => {
  const child = { ...file, id: 'nested', name: 'nested.txt', parentId: 'folder', sizeBytes: 3000 }
  const snapshot: ScanSnapshot = {
    entries: { scanId: 'published', rootEntryId: 'root' },
    root,
    completedAt: '2026-11-16T00:00:00Z',
    entryCount: 4,
    summary: { fileCount: 2, directoryCount: 2, totalBytes: 4000, errorCount: 1 },
    incomplete: true
  }
  const getSnapshot = vi.fn<SpaceLensAPI['getScanSnapshot']>()
  getSnapshot.mockResolvedValue({
    ok: true,
    value: { snapshot, unavailable: { scanId: 'summary-only', reason: 'limit-exceeded' } }
  })
  list.mockImplementation(async ({ entryId }) => ({
    ok: true,
    value: page(entryId === 'root' ? [file, folder] : [child], { directoryId: entryId })
  }))
  const getEntry = vi.fn<SpaceLensAPI['getScanEntry']>()
  getEntry.mockImplementation(async ({ entryId }) => ({
    ok: true,
    value: entryId === 'folder' ? folder : file
  }))
  vi.stubGlobal('spaceLens', {
    listScanDirectory: list,
    getScanSnapshot: getSnapshot,
    getScanEntry: getEntry
  })
  render(<ExplorerPage />)
  const chart = within(screen.getByRole('region', { name: 'Treemap' }))
  const rootChart = await chart.findByRole('figure', { name: 'Storage distribution in Root' })
  expect(screen.getByText('Incomplete snapshot: known sizes may be partial.')).toBeVisible()
  expect(screen.getByText(/newer scan has summary-only results/)).toBeVisible()
  const contents = within(screen.getByRole('region', { name: 'Directory Contents' }))
  const details = within(screen.getByRole('region', { name: 'Details' }))
  const fileTile = within(rootChart).getByRole('button', { name: 'report.txt, file, 1 KB' })
  const folderTile = within(rootChart).getByRole('button', { name: 'Documents, directory, 3 KB' })
  const reportRow = await contents.findByRole('button', { name: 'report.txt' })
  const folderRow = contents.getByRole('button', { name: 'Documents' })

  fireEvent.click(fileTile)
  await details.findByRole('heading', { name: 'report.txt' })
  expect(reportRow).toHaveAttribute('aria-pressed', 'true')
  expect(fileTile).toHaveAttribute('aria-pressed', 'true')
  expect(folderTile).toHaveAttribute('aria-pressed', 'false')

  fireEvent.click(folderRow)
  await details.findByRole('heading', { name: 'Documents' })
  expect(folderTile).toHaveAttribute('aria-pressed', 'true')
  expect(fileTile).toHaveAttribute('aria-pressed', 'false')
  expect(chart.getByRole('figure', { name: 'Storage distribution in Root' })).toBeVisible()
  expect(list).toHaveBeenCalledTimes(2)

  act(() => folderTile.focus())
  expect(chart.getByText(/Aggregated size/)).toBeVisible()
  getEntry.mockResolvedValueOnce({
    ok: false,
    error: { code: 'ENTRY_NOT_FOUND', message: 'Directory no longer available' }
  })
  fireEvent.keyDown(folderTile, { key: 'Enter' })
  expect(await screen.findByRole('alert')).toHaveTextContent('ENTRY_NOT_FOUND')
  expect(folderTile).toHaveFocus()
  expect(folderTile).toHaveAttribute('aria-pressed', 'true')

  fireEvent.keyDown(folderTile, { key: 'Enter' })
  await chart.findByRole('figure', { name: 'Storage distribution in Documents' })
  expect(chart.getByRole('group', { name: 'Treemap visualization' })).toHaveFocus()
  expect(chart.queryByText(/Aggregated size/)).not.toBeInTheDocument()
  expect(chart.queryByText('report.txt, file: 1 KB')).not.toBeInTheDocument()
  expect(chart.getByText('nested.txt, file: 3 KB')).toBeInTheDocument()
  expect(chart.getByRole('button', { name: 'nested.txt, file, 3 KB' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  const breadcrumb = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
  expect(breadcrumb.getByText('Documents')).toHaveAttribute('aria-current', 'page')
  expect(await contents.findByRole('button', { name: 'nested.txt' })).toBeVisible()
  expect(details.getByText('No item selected')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await chart.findByRole('figure', { name: 'Storage distribution in Root' })
  fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
  await chart.findByRole('figure', { name: 'Storage distribution in Documents' })
  fireEvent.click(screen.getByRole('button', { name: 'Up' }))
  await chart.findByRole('figure', { name: 'Storage distribution in Root' })
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  const tree = within(screen.getByRole('region', { name: 'Directory Tree' }))
  const treeFolder = await tree.findByRole('button', { name: 'Documents' })
  fireEvent.doubleClick(chart.getByRole('button', { name: 'Documents, directory, 3 KB' }))
  await chart.findByRole('figure', { name: 'Storage distribution in Documents' })
  expect(treeFolder).toHaveAttribute('aria-current', 'location')
  getSnapshot.mockResolvedValue({
    ok: true,
    value: { snapshot: null, unavailable: { scanId: 'summary', reason: 'limit-exceeded' } }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }))
  await chart.findByText(/No treemap available/)
  expect(chart.queryByRole('figure')).not.toBeInTheDocument()
})
