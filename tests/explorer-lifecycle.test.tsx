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

function publishedFixture(
  scanId: string,
  name: string,
  errors = 0,
  extras = 0,
  deep = false
): SavedFixture {
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
  const deeper = {
    ...folder,
    id: 'deeper',
    parentId: folder.id,
    name: 'Deeper',
    path: `${folder.path}/Deeper`
  }
  const leaf = {
    ...deeper,
    id: 'leaf',
    parentId: deeper.id,
    name: 'Leaf',
    path: `${deeper.path}/Leaf`
  }
  const dirs = deep ? [root, folder, deeper, leaf] : [root, folder]
  const parent = deep ? leaf : folder
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
    file('nested', parent, deep ? 'Ω-target.bin' : 'inside.bin', 2000)
  ]
  for (let i = 0; i < extras; i++) {
    const name = `sample-${String(i).padStart(3, '0')}.bin`
    fileEntries.push(file(name.replace('.', '-'), deep ? leaf : root, name, 100 + i))
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
    ...[...dirs, ...fileEntries].map((entry) => ({ type: 'entry' as const, entry })),
    ...dirs.toReversed().map((dir) => ({
      type: 'directory-finalized' as const,
      entry: {
        ...dir,
        type: 'directory' as const,
        aggregatedSizeBytes: dir.id === root.id ? totalBytes : deep ? totalBytes - 3000 : 2000
      }
    }))
  ]
  for (let start = 0; start < operations.length; start += SCANNER_BATCH_SIZE) {
    database.applyBatch(scanId, operations.slice(start, start + SCANNER_BATCH_SIZE))
  }
  database.publishScan(
    {
      ...scan,
      status: 'completed',
      finishedAt: timestamp,
      summary: {
        fileCount: fileEntries.length,
        directoryCount: dirs.length,
        totalBytes,
        errorCount: errors
      }
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
  deleteLatest: (replacement?: SavedFixture) => void
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
    getInsightsSummary: vi.fn(async ({ scanId }) =>
      read(scanId, (store) => {
        const { rootPath, summary, finishedAt } = store.requirePublishedScan(scanId)
        return {
          scanId,
          rootPath,
          summary,
          completedAt: finishedAt,
          incomplete: summary.errorCount > 0
        }
      })
    ),
    getInsightsCategories: vi.fn(async ({ scanId }) =>
      read(scanId, (store) => store.getInsightsCategories(scanId))
    ),
    getInsightsSizeDistribution: vi.fn(async ({ scanId }) =>
      read(scanId, (store) => store.getInsightsSizeDistribution(scanId))
    ),
    getInsightsObservations: vi.fn(async ({ scanId }) =>
      read(scanId, (store) => store.getInsightsObservations(scanId))
    ),
    listInsightsExtensions: vi.fn(async ({ scanId, offset = 0, limit = 50 }) =>
      read(scanId, (store) => store.listInsightsExtensions({ scanId, offset, limit }))
    ),
    listInsightsLargestFiles: vi.fn(async ({ scanId, offset = 0, limit = 10 }) =>
      read(scanId, (store) => store.listInsightsLargest({ scanId, offset, limit }, 'file'))
    ),
    listInsightsLargestDirectories: vi.fn(async ({ scanId, offset = 0, limit = 10 }) =>
      read(scanId, (store) => store.listInsightsLargest({ scanId, offset, limit }, 'directory'))
    ),
    getScanState: vi.fn<SpaceLensAPI['getScanState']>(async () => ({ ok: true, value: state })),
    listScanHistory: vi.fn(),
    getScanHistoryMetadata: vi.fn(),
    deleteSnapshot: vi.fn(),
    getRetentionSettings: vi.fn(),
    setRetentionSettings: vi.fn(),
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
    deleteLatest: (replacement) => {
      published = replacement ?? null
      emit({
        latestCompleted: replacement ? summaryOf(replacement) : null,
        historyRevision: (state.historyRevision ?? 0) + 1
      })
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
function open(page: 'Overview' | 'Explorer' | 'Insights'): void {
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

const rankedFilePath = '/scans/Alpha/Nested/Deeper/Leaf/Ω-target.bin'
const rankedDirectoryPath = '/scans/Alpha/Nested/Deeper/Leaf'

async function rankedAction(kind: 'files' | 'directories', path: string): Promise<HTMLElement> {
  const ranking = await screen.findByRole('region', { name: `Largest ${kind}` })
  return within(ranking).findByRole('button', { name: `Open in Explorer: ${path}` })
}

test('hands off a ranked file once and selects it from its exact Contents page', async () => {
  const { api, restore } = mockApp()
  restore(publishedFixture('scan-a', 'Alpha', 1, 320, true))
  render(
    <StrictMode>
      <App />
    </StrictMode>
  )
  open('Insights')
  const action = await rankedAction('files', rankedFilePath)
  const summary = action.closest('li')!.querySelector('summary')!
  fireEvent.click(summary)
  expect(summary.parentElement).toHaveAttribute('open')
  expect(screen.getByRole('heading', { name: 'Storage Insights' })).toBeVisible()
  action.focus()
  expect(action).toHaveFocus()
  fireEvent.click(action)

  await chart('Leaf')
  expect(screen.getByRole('heading', { name: 'Storage Explorer' })).toHaveFocus()
  const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
  expect(
    Array.from(
      breadcrumb.querySelectorAll('button, [aria-current=page]'),
      (entry) => entry.textContent
    )
  ).toEqual(['Alpha', 'Nested', 'Deeper', 'Leaf'])
  expect(panel('Directory Tree').getByRole('button', { name: 'Leaf' })).toHaveAttribute(
    'aria-current',
    'location'
  )
  const contents = panel('Directory Contents')
  expect(contents.getByText('Page 4 of 4 · 321 entries')).toBeVisible()
  expect(contents.getByRole('button', { name: 'Ω-target.bin' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(
    panel('Treemap').getByRole('button', { name: 'Ω-target.bin, file, 2 KB' })
  ).toHaveAttribute('aria-pressed', 'true')
  expect(panel('Details').getByRole('heading', { name: 'Ω-target.bin' })).toBeVisible()
  expect(panel('Details').getByText(rankedFilePath)).toBeVisible()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(api.getScanEntry.mock.calls.map(([request]) => request)).toEqual(
    ['nested', 'leaf', 'deeper', 'folder'].map((entryId) => ({ scanId: 'scan-a', entryId }))
  )
  expect(api.listScanDirectory.mock.calls.map(([request]) => request)).toEqual(
    [
      [0, 1],
      [200, 1],
      [300, 1],
      [300, 100]
    ].map(([offset, limit]) => ({ scanId: 'scan-a', entryId: 'leaf', offset, limit }))
  )
  expect(api.getScanDirectoryTreemap).toHaveBeenCalledExactlyOnceWith({
    scanId: 'scan-a',
    entryId: 'leaf'
  })
})

test('opens a deep ranked directory and uses ordinary history, Up, and breadcrumbs after arrival', async () => {
  const { api, restore } = mockApp()
  restore(publishedFixture('scan-a', 'Alpha', 0, 5, true))
  render(<App />)
  open('Insights')
  fireEvent.click(await rankedAction('directories', rankedDirectoryPath))
  await chart('Leaf')
  expect(
    await panel('Directory Contents').findByRole('button', { name: 'Ω-target.bin' })
  ).toBeVisible()
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  expect(panel('Directory Tree').getByRole('button', { name: 'Leaf' })).toHaveAttribute(
    'aria-current',
    'location'
  )
  expect(api.getScanEntry).toHaveBeenNthCalledWith(1, { scanId: 'scan-a', entryId: 'leaf' })

  fireEvent.click(button('Back'))
  await chart('Alpha')
  fireEvent.click(button('Forward'))
  await chart('Leaf')
  fireEvent.click(button('Up'))
  await chart('Deeper')
  expect(panel('Directory Tree').getByRole('button', { name: 'Deeper' })).toHaveAttribute(
    'aria-current',
    'location'
  )
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', {
      name: 'Nested'
    })
  )
  await chart('Nested')

  open('Insights')
  fireEvent.click(await rankedAction('files', '/scans/Alpha/Alpha.txt'))
  await chart('Alpha')
  expect(
    await panel('Directory Contents').findByRole('button', { name: 'Alpha.txt' })
  ).toHaveAttribute('aria-pressed', 'true')
  expect(button('Back')).toHaveAttribute('aria-disabled', 'true')
  open('Overview')
  open('Explorer')
  await chart('Alpha')
  expect(panel('Details').getByText('No item selected')).toBeVisible()
})

test('rejects a ranked target when SQLite published a new scan before Explorer loads', async () => {
  const { api, restore, publish } = mockApp()
  restore(publishedFixture('scan-a', 'Alpha', 0, 4, true))
  const beta = publishedFixture('scan-b', 'Beta')
  render(<App />)
  open('Insights')
  const target = await rankedAction('files', rankedFilePath)
  publish(beta, { notify: false })
  fireEvent.click(target)
  await chart('Beta')
  expect(screen.getByRole('alert')).toHaveTextContent('The scan has changed')
  expect(api.getScanEntry).not.toHaveBeenCalled()
  expect(panel('Details').getByText('No item selected')).toBeVisible()
})

test('discards in-flight target resolution when a replacement is published', async () => {
  const { api, restore, publish } = mockApp()
  const alpha = publishedFixture('scan-a', 'Alpha', 0, 4, true)
  restore(alpha)
  const beta = publishedFixture('scan-b', 'Beta')
  render(<App />)
  open('Insights')
  const target = await rankedAction('files', rankedFilePath)
  const pending = Promise.withResolvers<ScannerIpcResult<FileEntry>>()
  api.getScanEntry.mockReturnValueOnce(pending.promise)
  fireEvent.click(target)
  await waitFor(() =>
    expect(api.getScanEntry).toHaveBeenCalledExactlyOnceWith({
      scanId: 'scan-a',
      entryId: 'nested'
    })
  )
  act(() => publish(beta))
  await chart('Beta')
  await act(async () =>
    pending.resolve({
      ok: true,
      value: alpha.database.getScanEntry({ scanId: 'scan-a', entryId: 'nested' })
    })
  )
  expect(screen.getByRole('alert')).toHaveTextContent('The scan has changed')
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  expect(api.getScanEntry).toHaveBeenCalledOnce()
  expect(api.listScanDirectory.mock.calls.every(([request]) => request.scanId === 'scan-b')).toBe(
    true
  )
})

test('keeps Explorer usable at the published root when the target entry is missing', async () => {
  const { api, restore } = mockApp()
  restore(publishedFixture('scan-a', 'Alpha', 0, 4, true))
  render(<App />)
  open('Insights')
  const target = await rankedAction('files', rankedFilePath)
  api.getScanEntry.mockResolvedValueOnce({
    ok: false,
    error: { code: 'ENTRY_NOT_FOUND', message: 'Missing entry' }
  })
  fireEvent.click(target)
  await chart('Alpha')
  expect(screen.getByRole('alert')).toHaveTextContent('The ranked item is unavailable')
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  fireEvent.click(await panel('Directory Contents').findByRole('button', { name: 'Alpha.txt' }))
  expect(await panel('Details').findByRole('heading', { name: 'Alpha.txt' })).toBeVisible()
})

test('refreshes once when a target read expires before the replacement notification', async () => {
  const { api, restore, publish } = mockApp()
  restore(publishedFixture('scan-a', 'Alpha', 0, 4, true))
  const beta = publishedFixture('scan-b', 'Beta')
  render(<App />)
  open('Insights')
  const target = await rankedAction('files', rankedFilePath)
  api.getScanEntry.mockImplementationOnce(async () => {
    publish(beta, { notify: false })
    return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Replaced fixture' } }
  })
  fireEvent.click(target)
  await chart('Beta')
  expect(screen.getByRole('alert')).toHaveTextContent('The scan has changed')
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(3)
  expect(api.getScanEntry).toHaveBeenCalledOnce()
  expect(panel('Details').getByText('No item selected')).toBeVisible()
})

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

test.each(['Explorer', 'Insights'] as const)(
  'refreshes %s when deleting Latest and clears it after the final deletion',
  async (page) => {
    const main = mockApp()
    const previous = publishedFixture('previous', 'Previous')
    main.restore(publishedFixture('latest', 'Latest'))
    render(<App />)
    open(page)
    if (page === 'Explorer') await chart('Latest')
    else await screen.findByText('/scans/Latest')
    act(() => main.deleteLatest(previous))
    if (page === 'Explorer') await chart('Previous')
    else await screen.findByText('/scans/Previous')
    act(() => main.deleteLatest())
    await screen.findByText(page === 'Explorer' ? /No published snapshot yet/ : /No completed scan/)
    open('Overview')
    await panel('Recent Scans').findByText('No scans yet')
  }
)

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
