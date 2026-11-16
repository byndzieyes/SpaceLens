import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import type { ScanSnapshot } from '../src/shared/snapshot'
import { DirectoryTreemap } from '../src/renderer/src/features/explorer/DirectoryTreemap'
import { Treemap } from '../src/renderer/src/features/explorer/Treemap'
import { createTreemapData } from '../src/renderer/src/features/explorer/treemapData'
import { ExplorerPage } from '../src/renderer/src/pages/ExplorerPage'
import {
  treemapFile as file,
  treemapFolder as folder,
  treemapRoot as root,
  treemapPage as page
} from './treemap-fixtures'

const list = vi.fn<SpaceLensAPI['listScanDirectory']>()
const props = { scanId: 'published', directory: root }
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

test('renders static SVG with semantic description, clipped readable labels and accessible entry sizes', () => {
  const name = 'long-name-'.repeat(200)
  const { container } = render(
    <Treemap data={createTreemapData(root, [{ ...file, name }, folder])} />
  )
  const image = screen.getByRole('img', { name: 'Storage distribution in Root' })
  expect(image).toHaveAccessibleDescription(
    /Rectangle area represents known logical storage size of direct children/
  )
  expect(container.querySelectorAll('svg g[data-entry-id]')).toHaveLength(2)
  expect(container.querySelectorAll('svg text')).toHaveLength(2)
  for (const text of container.querySelectorAll('svg text'))
    expect(text).toHaveAttribute('clip-path')
  expect(container.querySelector('svg text')?.textContent).toContain('Documents')
  expect(container.querySelectorAll('clipPath')).toHaveLength(2)
  expect(container.querySelectorAll('button, [tabindex]')).toHaveLength(0)
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

test('responds to container resizing without requesting data and disconnects its observer', () => {
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
  const { unmount } = render(<Treemap data={createTreemapData(root, [file, folder])} />)
  for (const width of [280, 400, 900, 1280]) {
    act(() =>
      resize([{ contentRect: { width, height: 320 } } as ResizeObserverEntry], {} as ResizeObserver)
    )
    expect(screen.getByRole('img')).toHaveAttribute('viewBox', `0 0 ${width} 320`)
  }
  expect(observe).toHaveBeenCalledOnce()
  expect(list).not.toHaveBeenCalled()
  unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})

test('loads one complete page with actual published scan ID and no entry-detail or recursive requests', async () => {
  render(<DirectoryTreemap {...props} />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading treemap')
  await screen.findByRole('img')
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
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(list).toHaveBeenCalledTimes(1)
})

test('exactly 100 direct entries are supported when pagination metadata is complete', async () => {
  list.mockResolvedValue({
    ok: true,
    value: page(Array.from({ length: 100 }, (_, i) => ({ ...file, id: `file-${i}` })))
  })
  const { container } = render(<DirectoryTreemap {...props} />)
  await screen.findByRole('img')
  expect(container.querySelectorAll('svg g[data-entry-id]')).toHaveLength(100)
  expect(list).toHaveBeenCalledTimes(1)
})

test.each([
  { scanId: null, directory: null },
  { scanId: null, directory: root },
  { scanId: 'published', directory: null }
])('unavailable snapshot or directory %o makes no requests', async (identity) => {
  render(<DirectoryTreemap {...identity} />)
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
    view.rerender(<DirectoryTreemap scanId={null} directory={null} />)
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
      expect(screen.getByRole('img')).toBeVisible()
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
    await screen.findByRole('img')
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
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
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
  view.rerender(<DirectoryTreemap {...identity} />)
  await screen.findByText('This directory is empty. No treemap to display.')
  await act(async () => old.resolve({ ok: true, value: page() }))
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
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

test('Explorer keeps warnings and shared selection/navigation while treemap follows direct-child directories', async () => {
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
  await chart.findByRole('img', { name: 'Storage distribution in Root' })
  expect(screen.getByText('Incomplete snapshot: known sizes may be partial.')).toBeVisible()
  expect(screen.getByText(/newer scan has summary-only results/)).toBeVisible()
  const contents = within(screen.getByRole('region', { name: 'Directory Contents' }))
  fireEvent.click(contents.getByRole('button', { name: 'report.txt' }))
  const details = within(screen.getByRole('region', { name: 'Details' }))
  await details.findByRole('heading', { name: 'report.txt' })
  expect(chart.getByRole('img', { name: 'Storage distribution in Root' })).toBeVisible()
  fireEvent.doubleClick(contents.getByRole('button', { name: 'Documents' }))
  await chart.findByRole('img', { name: 'Storage distribution in Documents' })
  expect(chart.queryByText('report.txt, file: 1 KB')).not.toBeInTheDocument()
  expect(chart.getByText('nested.txt, file: 3 KB')).toBeInTheDocument()
  expect(details.getByText('No item selected')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await chart.findByRole('img', { name: 'Storage distribution in Root' })
  fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
  await chart.findByRole('img', { name: 'Storage distribution in Documents' })
  fireEvent.click(screen.getByRole('button', { name: 'Up' }))
  await chart.findByRole('img', { name: 'Storage distribution in Root' })
  fireEvent.click(screen.getByRole('button', { name: 'Expand Root' }))
  const tree = within(screen.getByRole('region', { name: 'Directory Tree' }))
  fireEvent.click(await tree.findByRole('button', { name: 'Documents' }))
  await chart.findByRole('img', { name: 'Storage distribution in Documents' })
  getSnapshot.mockResolvedValue({
    ok: true,
    value: { snapshot: null, unavailable: { scanId: 'summary', reason: 'limit-exceeded' } }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }))
  await chart.findByText(/No treemap available/)
  expect(chart.queryByRole('img')).not.toBeInTheDocument()
})
