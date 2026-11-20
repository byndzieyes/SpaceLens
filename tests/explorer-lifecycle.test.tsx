import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi, type Mocked } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import { SnapshotAccessError } from '../src/main/storage/snapshotAccess'
import { SCANNER_BATCH_SIZE } from '../src/main/scanner/workerProtocol'
import type { StorageBatchOperation } from '../src/main/storage/payloads'
import App from '../src/renderer/src/App'
import type { ScannerIpcResult, ScanStateSnapshot, SpaceLensAPI } from '../src/shared/ipc'
import type { FileEntry, RecentScanSummary, ScanSessionState, ScanStatus } from '../src/shared/scan'
import type { ScanSnapshot, ScanSnapshotAvailability } from '../src/shared/snapshot'

const timestamp = '2026-11-18T14:00:00Z'

type SavedFixture = { database: ScanDatabase; snapshot: ScanSnapshot }
const databases = new Set<ScanDatabase>()

function publishedFixture(scanId: string, name: string, errors = 0, extras = 0): SavedFixture {
  const path = `/scans/${name}`
  const database = new ScanDatabase(':memory:')
  databases.add(database)
  const root: FileEntry = {
    id: 'root',
    scanId,
    parentId: null,
    name,
    path,
    type: 'directory',
    sizeBytes: null,
    aggregatedSizeBytes: null,
    createdAt: null,
    modifiedAt: null
  }
  const folder = {
    ...root,
    parentId: root.id,
    id: 'folder',
    name: 'Nested',
    path: `${path}/Nested`
  }
  const file = (id: string, parent: FileEntry, name: string, sizeBytes: number): FileEntry => ({
    ...root,
    id,
    parentId: parent.id,
    name,
    path: `${parent.path}/${name}`,
    sizeBytes,
    type: 'file'
  })
  const fileEntries = [
    file('report', root, `${name}.txt`, 3000),
    file('nested', folder, 'inside.bin', 2000)
  ]
  for (let i = 0; i < extras; i++) {
    const name = `sample-${String(i).padStart(3, '0')}.bin`
    fileEntries.push(file(name.replace('.', '-'), root, name, 100 + i))
  }
  const scan = { id: scanId, rootPath: path, startedAt: timestamp }
  database.beginScan({
    ...scan,
    status: 'running',
    finishedAt: null,
    summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
  })
  const totalBytes = fileEntries.reduce((total, entry) => total + entry.sizeBytes!, 0)
  const operations: StorageBatchOperation[] = [
    ...[root, folder, ...fileEntries].map((entry) => ({ type: 'entry' as const, entry })),
    {
      type: 'directory-finalized',
      entry: { ...folder, type: 'directory', aggregatedSizeBytes: 2000 }
    },
    {
      type: 'directory-finalized',
      entry: { ...root, type: 'directory', aggregatedSizeBytes: totalBytes }
    }
  ]
  for (let start = 0; start < operations.length; start += SCANNER_BATCH_SIZE) {
    database.applyBatch(scanId, operations.slice(start, start + SCANNER_BATCH_SIZE))
  }
  database.publishScan(
    {
      ...scan,
      status: 'completed',
      finishedAt: timestamp,
      summary: { fileCount: fileEntries.length, directoryCount: 2, totalBytes, errorCount: errors }
    },
    root.id
  )
  return { database, snapshot: database.getScanSnapshot().snapshot! }
}

function mockApp(): {
  api: Mocked<SpaceLensAPI>
  listeners: Set<(snapshot: ScanStateSnapshot) => void>
  publish: (storage: SavedFixture, options?: { notify?: boolean }) => void
  restore: (storage: SavedFixture) => void
  runNext: (id: string) => void
} {
  let published: SavedFixture | null = null
  let state: ScanStateSnapshot = { revision: 0, state: null, publicationStatus: 'ready' }
  const listeners = new Set<(snapshot: ScanStateSnapshot) => void>()
  const activeScan = (id: string, status: ScanStatus, rootPath: string): ScanSessionState => {
    const stats =
      published?.snapshot.entries.scanId === id
        ? published.snapshot.summary
        : {
            fileCount: 0,
            directoryCount: 1,
            totalBytes: 0,
            errorCount: 0
          }
    const session = { id, rootPath, startedAt: timestamp, summary: stats }
    return {
      session:
        status === 'running'
          ? { ...session, status, finishedAt: null }
          : { ...session, status, finishedAt: timestamp },
      progress: {
        scanId: id,
        processedFileCount: stats.fileCount,
        processedDirectoryCount: stats.directoryCount,
        processedBytes: stats.totalBytes,
        currentPath: rootPath
      },
      failure:
        status === 'failed' ? { name: 'Error', code: 'SCAN_FAILED', message: 'Scan failed.' } : null
    }
  }
  const emit = (patch: Partial<ScanStateSnapshot>): void => {
    state = { ...state, ...patch, revision: state.revision + 1 }
    for (const listener of listeners) listener(state)
  }
  const summaryOf = ({ snapshot }: SavedFixture): RecentScanSummary => ({
    id: snapshot.entries.scanId,
    path: snapshot.root.path,
    completedAt: snapshot.completedAt,
    ...snapshot.summary
  })
  const publish = (storage: SavedFixture, { notify = true } = {}): void => {
    published = storage
    const { root, entries } = storage.snapshot
    const patch = {
      state: activeScan(entries.scanId, 'completed', root.path),
      latestCompleted: summaryOf(storage)
    }
    if (notify) emit(patch)
    else state = { ...state, ...patch, revision: state.revision + 1 }
  }
  function read<T>(scanId: string, load: (store: ScanDatabase) => T): ScannerIpcResult<T> {
    if (published?.snapshot.entries.scanId !== scanId)
      return {
        ok: false,
        error: {
          code: published ? 'SNAPSHOT_EXPIRED' : 'SNAPSHOT_UNAVAILABLE',
          message: 'Snapshot is no longer available.'
        }
      }
    try {
      return { ok: true, value: load(published.database) }
    } catch (error) {
      if (error instanceof SnapshotAccessError)
        return { ok: false, error: { code: error.code, message: error.message } }
      throw error
    }
  }
  let nextId = 'scan-a'
  const api: Mocked<SpaceLensAPI> = {
    getAppInfo: vi.fn<SpaceLensAPI['getAppInfo']>(),
    getScanState: vi.fn<SpaceLensAPI['getScanState']>(async () => ({ ok: true, value: state })),
    getScanSnapshot: vi.fn<SpaceLensAPI['getScanSnapshot']>(async () => ({
      ok: true,
      value: {
        snapshot: published?.snapshot ?? null,
        unavailable: null
      }
    })),
    getScanEntry: vi.fn<SpaceLensAPI['getScanEntry']>(async (request) =>
      read(request.scanId, (store) => store.getScanEntry(request))
    ),
    getScanDirectoryTreemap: vi.fn<SpaceLensAPI['getScanDirectoryTreemap']>(async (request) =>
      read(request.scanId, (store) => store.getScanDirectoryTreemap(request))
    ),
    listScanDirectory: vi.fn<SpaceLensAPI['listScanDirectory']>(async (request) =>
      read(request.scanId, (store) => store.listScanDirectory(request))
    ),
    onScanStateChanged: vi.fn<SpaceLensAPI['onScanStateChanged']>((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    selectScanDirectory: vi.fn<SpaceLensAPI['selectScanDirectory']>(async () => ({
      ok: true,
      value: { cancelled: false, rootPath: '/scans/Alpha' }
    })),
    startScan: vi.fn<SpaceLensAPI['startScan']>(async ({ rootPath }) => {
      emit({ state: activeScan(nextId, 'running', rootPath) })
      return { ok: true, value: { scanId: nextId } }
    }),
    cancelScan: vi.fn<SpaceLensAPI['cancelScan']>(async ({ scanId }) => {
      emit({ state: activeScan(scanId, 'cancelled', '/scans/Beta') })
      return { ok: true, value: { scanId } }
    })
  }
  vi.stubGlobal('spaceLens', api)
  vi.stubGlobal('ResizeObserver', undefined)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  return {
    api,
    listeners,
    publish,
    restore: (storage) => {
      published = storage
      state = { ...state, state: null, latestCompleted: summaryOf(storage) }
    },
    runNext: (id: string) => {
      nextId = id
    }
  }
}

afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
  vi.unstubAllGlobals()
})

const panel = (name: string): ReturnType<typeof within> =>
  within(screen.getByRole('region', { name }))
const button = (name: string): HTMLElement => screen.getByRole('button', { name })
function open(page: 'Overview' | 'Explorer'): void {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', {
      name: page
    })
  )
}
async function chart(directory: string): Promise<HTMLElement> {
  return panel('Treemap').findByRole('figure', { name: `Storage distribution in ${directory}` })
}
async function start(): Promise<void> {
  await waitFor(() => expect(button('Scan Folder')).toBeEnabled())
  fireEvent.click(button('Scan Folder'))
  await screen.findByText('Scanning')
}

test('a settled scan opens Explorer with one published identity across all four panels', async () => {
  const { api, listeners, publish } = mockApp()
  const alpha = publishedFixture('scan-a', 'Alpha', 1)
  render(
    <StrictMode>
      <App />
    </StrictMode>
  )
  expect(screen.getByRole('heading', { name: 'Storage Overview' })).toBeVisible()
  await start()
  expect(api.selectScanDirectory).toHaveBeenCalledOnce()
  expect(api.startScan).toHaveBeenCalledExactlyOnceWith({ rootPath: '/scans/Alpha' })
  expect(listeners.size).toBe(1)
  expect(api.getScanSnapshot).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Open in Explorer' })).not.toBeInTheDocument()
  act(() => publish(alpha))
  fireEvent.click(button('Open in Explorer'))
  await chart('Alpha')
  expect(screen.getByText('Incomplete snapshot: known sizes may be partial.')).toBeVisible()
  expect(listeners.size).toBe(1)
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  fireEvent.click(button('Expand Alpha'))
  const treeFolder = await panel('Directory Tree').findByRole('button', { name: 'Nested' })
  fireEvent.click(await panel('Directory Contents').findByRole('button', { name: 'Alpha.txt' }))
  await panel('Details').findByRole('heading', { name: 'Alpha.txt' })
  expect(panel('Treemap').getByRole('button', { name: 'Alpha.txt, file, 3 KB' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  fireEvent.doubleClick(panel('Treemap').getByRole('button', { name: 'Nested, directory, 2 KB' }))
  await chart('Nested')
  expect(treeFolder).toHaveAttribute('aria-current', 'location')
  expect(
    await panel('Directory Contents').findByRole('button', { name: 'inside.bin' })
  ).toBeVisible()
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  expect(api.getScanDirectoryTreemap.mock.calls.map(([request]) => request.scanId)).toEqual([
    'scan-a',
    'scan-a'
  ])
  expect(api.getScanEntry.mock.calls.map(([request]) => request.scanId)).toEqual([
    'scan-a',
    'scan-a'
  ])
  expect(api.listScanDirectory.mock.calls.map(([request]) => request.scanId)).toEqual([
    'scan-a',
    'scan-a',
    'scan-a'
  ])
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  open('Overview')
  await screen.findByText('Completed with errors')
  expect(listeners.size).toBe(1)
  open('Explorer')
  await chart('Alpha')
  expect(button('Back')).toHaveAttribute('aria-disabled', 'true')
  expect(button('Expand Alpha')).toHaveAttribute('aria-expanded', 'false')
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(api.cancelScan).not.toHaveBeenCalled()
})

test('preserves the prior Treemap during a scan and cancellation, then renders a replacement', async () => {
  const main = mockApp()
  main.publish(publishedFixture('scan-a', 'Alpha'))
  main.runNext('scan-b')
  render(<App />)
  await start()
  open('Explorer')
  await chart('Alpha')
  fireEvent.doubleClick(await panel('Directory Contents').findByRole('button', { name: 'Nested' }))
  await chart('Nested')
  expect(main.api.cancelScan).not.toHaveBeenCalled()
  open('Overview')
  await screen.findByText('Scanning')
  fireEvent.click(button('Cancel Scan'))
  await screen.findByText('Scan cancelled')
  expect(main.api.cancelScan).toHaveBeenCalledExactlyOnceWith({ scanId: 'scan-b' })
  open('Explorer')
  await chart('Alpha')
  act(() => main.publish(publishedFixture('scan-c', 'Replacement')))
  const replacementChart = await chart('Replacement')
  fireEvent.click(
    within(replacementChart).getByRole('button', { name: 'Replacement.txt, file, 3 KB' })
  )
  await panel('Details').findByRole('heading', { name: 'Replacement.txt' })
  expect(main.api.getScanDirectoryTreemap).toHaveBeenLastCalledWith({
    scanId: 'scan-c',
    entryId: 'root'
  })
})

test('refreshes automatically on publication and ignores late panel data from the old snapshot', async () => {
  const main = mockApp()
  const alpha = publishedFixture('scan-a', 'Alpha')
  const beta = publishedFixture('scan-b', 'Beta')
  main.publish(alpha)
  render(<App />)
  open('Explorer')
  await chart('Alpha')
  fireEvent.click(button('Expand Alpha'))
  const folder = await panel('Directory Tree').findByRole('button', { name: 'Nested' })
  fireEvent.click(folder)
  await chart('Nested')
  fireEvent.click(button('Back'))
  await chart('Alpha')
  expect(button('Forward')).toHaveAttribute('aria-disabled', 'false')
  const pending = Promise.withResolvers<ScannerIpcResult<FileEntry>>()
  main.api.getScanEntry.mockReturnValueOnce(pending.promise)
  fireEvent.click(await panel('Directory Contents').findByRole('button', { name: 'Alpha.txt' }))
  await panel('Details').findByText('Loading item details…')
  await waitFor(() =>
    expect(main.api.getScanEntry).toHaveBeenLastCalledWith({ scanId: 'scan-a', entryId: 'report' })
  )
  act(() => main.publish(beta))
  await chart('Beta')
  expect(main.api.getScanSnapshot).toHaveBeenCalledTimes(2)
  await act(async () =>
    pending.resolve({
      ok: true,
      value: alpha.database.getScanEntry({ scanId: 'scan-a', entryId: 'report' })
    })
  )
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  expect(button('Forward')).toHaveAttribute('aria-disabled', 'true')
  expect(button('Back')).toHaveAttribute('aria-disabled', 'true')
  expect(button('Expand Beta')).toHaveAttribute('aria-expanded', 'false')
  expect(await panel('Directory Contents').findByRole('button', { name: 'Beta.txt' })).toBeVisible()
  expect(main.api.getScanDirectoryTreemap).toHaveBeenLastCalledWith({
    scanId: 'scan-b',
    entryId: 'root'
  })
})

test('activates a long breadcrumb ancestor and keeps focus in the toolbar', async () => {
  const main = mockApp()
  const name = 'folder-name-without-spaces-'.repeat(8)
  main.publish(publishedFixture('scan-a', name))
  render(<App />)
  open('Explorer')
  await chart(name)
  fireEvent.doubleClick(await panel('Directory Contents').findByRole('button', { name: 'Nested' }))
  await chart('Nested')
  const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
  const ancestor = within(breadcrumb).getByRole('button', { name })
  expect(ancestor).toHaveAttribute('title', `/scans/${name}`)
  ancestor.focus()
  fireEvent.click(ancestor)
  await chart(name)
  expect(breadcrumb).toHaveFocus()
  expect(within(breadcrumb).getByText(name)).toHaveAttribute('aria-current', 'page')
})

test('refreshes a replaced snapshot from an expired panel and focuses the toolbar action', async () => {
  const main = mockApp()
  main.publish(publishedFixture('scan-a', 'Alpha'))
  render(<App />)
  open('Explorer')
  await chart('Alpha')
  act(() => main.publish(publishedFixture('scan-b', 'Beta'), { notify: false }))
  fireEvent.click(button('Expand Alpha'))
  const tree = panel('Directory Tree')
  expect(await tree.findByRole('alert')).toHaveTextContent('Use Refresh snapshot')
  const action = tree.getByRole('button', { name: 'Refresh snapshot for Alpha in Directory Tree' })
  action.focus()
  fireEvent.click(action)
  await chart('Beta')
  expect(button('Refresh snapshot')).toHaveFocus()
  expect(main.api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(tree.queryByRole('alert')).not.toBeInTheDocument()
})

test('leaving Explorer ignores pending availability and a new publication is resolved from the missing state', async () => {
  const main = mockApp()
  const late = Promise.withResolvers<ScannerIpcResult<ScanSnapshotAvailability>>()
  main.api.getScanSnapshot.mockReturnValueOnce(late.promise)
  render(<App />)
  await start()
  open('Explorer')
  await waitFor(() => expect(main.api.getScanSnapshot).toHaveBeenCalledOnce())
  expect(screen.queryByText('No directories displayed')).not.toBeInTheDocument()
  open('Overview')
  await screen.findByText('Scanning')
  await act(async () =>
    late.resolve({
      ok: true,
      value: { snapshot: publishedFixture('old', 'Old').snapshot, unavailable: null }
    })
  )
  expect(main.api.listScanDirectory).not.toHaveBeenCalled()
  expect(main.api.getScanDirectoryTreemap).not.toHaveBeenCalled()
  open('Explorer')
  await screen.findByText(/No published snapshot yet/)
  act(() => main.publish(publishedFixture('scan-new', 'Published')))
  await panel('Directory Contents').findByRole('button', { name: 'Published.txt' })
  await chart('Published')
  expect(main.api.cancelScan).not.toHaveBeenCalled()
})

test('restores the same publication in Overview and Explorer with the scanner idle', async () => {
  const main = mockApp()
  main.restore(publishedFixture('saved', 'Saved', 0, 104))
  render(<App />)
  await panel('Recent Scans').findByText('/scans/Saved')
  expect(panel('Folder scan').getByText('Ready to scan')).toBeVisible()
  expect(panel('Folder scan').queryByText('Scan completed')).not.toBeInTheDocument()
  fireEvent.click(button('Open in Explorer'))
  const figure = await chart('Saved')
  expect(within(figure).getByRole('img', { name: /Other.*6 grouped entries/ })).toBeVisible()
  fireEvent.click(within(figure).getByRole('button', { name: 'Saved.txt, file, 3 KB' }))
  await panel('Details').findByRole('heading', { name: 'Saved.txt' })
  expect(main.api.getScanDirectoryTreemap).toHaveBeenCalledExactlyOnceWith({
    scanId: 'saved',
    entryId: 'root'
  })
})

test('Top-N and inert Other coexist with independent Contents pagination and selection resets', async () => {
  const main = mockApp()
  main.publish(publishedFixture('large', 'Large', 0, 104))
  render(<App />)
  open('Explorer')
  const figure = await chart('Large')
  const tiles = within(figure)
  const group = tiles.getByRole('img', { name: /Other.*6 grouped entries/ })
  fireEvent.click(tiles.getByRole('button', { name: 'Large.txt, file, 3 KB' }))
  await panel('Details').findByRole('heading', { name: 'Large.txt' })
  fireEvent.doubleClick(group)
  fireEvent.keyDown(group, { key: 'Enter' })
  expect(panel('Details').getByRole('heading', { name: 'Large.txt' })).toBeVisible()
  expect(main.api.getScanEntry).toHaveBeenCalledExactlyOnceWith({
    scanId: 'large',
    entryId: 'report'
  })
  expect(button('Back')).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(button('Next page'))
  await panel('Directory Contents').findByText(/Page 2.*106 entries/)
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  expect(tiles.getByRole('button', { name: 'Large.txt, file, 3 KB' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  expect(main.api.getScanDirectoryTreemap).toHaveBeenCalledExactlyOnceWith({
    scanId: 'large',
    entryId: 'root'
  })
  expect(main.api.listScanDirectory.mock.calls.map(([query]) => query.offset)).toEqual([0, 100])
})
