import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi, type Mocked } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import { SnapshotAccessError } from '../src/main/storage/snapshotAccess'
import { SCANNER_BATCH_SIZE } from '../src/main/scanner/workerProtocol'
import type { StorageBatchOperation } from '../src/main/storage/payloads'
import App from '../src/renderer/src/App'
import { ExplorerPage } from '../src/renderer/src/pages/ExplorerPage'
import { InsightsPage } from '../src/renderer/src/pages/InsightsPage'
import { useSnapshotSelections } from '../src/renderer/src/features/snapshots/selection'
import { useSnapshotNavigation } from '../src/renderer/src/features/snapshots/useSnapshotNavigation'
import { rankedExplorerTarget, type SnapshotNavigationTarget } from '../src/renderer/src/navigation'
import type { InsightsCategories } from '../src/shared/insights'
import { mockSnapshotSelection } from './snapshot-selection-fixture'
import { recentHistoryPage } from './recent-scans-fixture'
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
  changeHistory: () => void
  runNext: (id: string) => void
} {
  let published: SavedFixture | null = null
  let retained: SavedFixture[] = []
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
  const remember = (storage: SavedFixture): void => {
    const id = storage.snapshot.entries.scanId
    retained = [storage, ...retained.filter(({ snapshot }) => snapshot.entries.scanId !== id)]
  }
  const publish = (storage: SavedFixture, { notify = true } = {}): void => {
    published = storage
    remember(storage)
    const { root, entries } = storage.snapshot
    const patch = {
      state: activeScan(entries.scanId, 'completed', root.path),
      latestCompleted: summaryOf(storage),
      historyRevision: (state.historyRevision ?? 0) + 1
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
    ...mockSnapshotSelection(() => api.getScanSnapshot()),
    getAppInfo: vi.fn<SpaceLensAPI['getAppInfo']>(),
    getInsightsSummary: vi.fn(async ({ scanId }) =>
      read(scanId, (store) => {
        const { rootPath, summary, finishedAt } = store.requireValidatedScan(scanId)
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
    listScanHistory: vi.fn(async () => ({
      ok: true,
      value: recentHistoryPage(
        retained.map(({ database, snapshot }) =>
          database.getScanHistoryMetadata({ scanId: snapshot.entries.scanId })
        )
      )
    })),
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
      remember(storage)
      state = { ...state, state: null, latestCompleted: summaryOf(storage) }
    },
    deleteLatest: (replacement) => {
      retained = retained.filter(
        ({ snapshot }) => snapshot.entries.scanId !== published?.snapshot.entries.scanId
      )
      published = replacement ?? null
      if (replacement) remember(replacement)
      else retained = []
      emit({
        latestCompleted: replacement ? summaryOf(replacement) : null,
        historyRevision: (state.historyRevision ?? 0) + 1
      })
    },
    changeHistory: () => emit({ historyRevision: (state.historyRevision ?? 0) + 1 }),
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

function historicalApp(...saved: SavedFixture[]): ReturnType<typeof mockApp> {
  const main = mockApp()
  const { api } = main
  const retained = new Map(saved.map((storage) => [storage.snapshot.entries.scanId, storage]))
  const prepareLatest = api.prepareSnapshotSelection.getMockImplementation()!
  api.prepareSnapshotSelection.mockImplementation(async (request) => {
    if (request.selection.mode === 'follow-latest') return prepareLatest(request)
    const { scanId } = request.selection
    const fixture = retained.get(scanId)
    if (!fixture)
      return {
        ok: false,
        error: { code: 'SNAPSHOT_EXPIRED', message: 'This saved scan no longer exists.' }
      }
    const latest = await api.getScanState()
    return {
      ok: true,
      value: {
        ticket: scanId,
        resolution: {
          mode: 'explicit',
          metadata: {
            ...fixture.database.getScanHistoryMetadata({ scanId }),
            isLatest: latest.ok && latest.value.latestCompleted?.id === scanId
          }
        }
      }
    }
  })
  api.adoptSnapshotSelection.mockImplementation(async ({ view, ticket }) => {
    const fixture = retained.get(ticket)
    return {
      ok: true,
      value:
        view === 'explorer'
          ? (fixture?.database.openSavedSnapshot({ scanId: ticket }) ?? null)
          : null
    }
  })
  function browse<T>(scanId: string, query: (database: ScanDatabase) => T): ScannerIpcResult<T> {
    const fixture = retained.get(scanId)
    if (!fixture)
      return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Missing fixture.' } }
    return { ok: true, value: query(fixture.database) }
  }
  api.getScanEntry.mockImplementation(async (request) =>
    browse(request.scanId, (db) => db.getScanEntry(request))
  )
  api.listScanDirectory.mockImplementation(async (request) =>
    browse(request.scanId, (db) => db.listScanDirectory(request))
  )
  api.getScanDirectoryTreemap.mockImplementation(async (request) =>
    browse(request.scanId, (db) => db.getScanDirectoryTreemap(request))
  )
  api.getInsightsSummary.mockImplementation(async ({ scanId }) =>
    browse(scanId, (db) => {
      const { rootPath, finishedAt, summary } = db.requireValidatedScan(scanId)
      return {
        scanId,
        rootPath,
        completedAt: finishedAt,
        summary,
        incomplete: summary.errorCount > 0
      }
    })
  )
  api.getInsightsCategories.mockImplementation(async ({ scanId }) =>
    browse(scanId, (db) => db.getInsightsCategories(scanId))
  )
  api.getInsightsSizeDistribution.mockImplementation(async ({ scanId }) =>
    browse(scanId, (db) => db.getInsightsSizeDistribution(scanId))
  )
  api.getInsightsObservations.mockImplementation(async ({ scanId }) =>
    browse(scanId, (db) => db.getInsightsObservations(scanId))
  )
  api.listInsightsExtensions.mockImplementation(async (request) =>
    browse(request.scanId, (db) => db.listInsightsExtensions(request))
  )
  api.listInsightsLargestFiles.mockImplementation(async (request) =>
    browse(request.scanId, (db) => db.listInsightsLargest(request, 'file'))
  )
  api.listInsightsLargestDirectories.mockImplementation(async (request) =>
    browse(request.scanId, (db) => db.listInsightsLargest(request, 'directory'))
  )
  return main
}

function HistoricalExplorer({
  targets
}: {
  targets: readonly { label: string; destination: SnapshotNavigationTarget }[]
}): React.JSX.Element {
  const selections = useSnapshotSelections()
  const { destination, navigate, navigateToSnapshot, consumeTarget, viewOptions } =
    useSnapshotNavigation(selections)
  return (
    <>
      {targets.map(({ label, destination }) => (
        <button key={label} onClick={() => navigateToSnapshot(destination)}>
          {label}
        </button>
      ))}
      <main tabIndex={-1}>
        {destination.page === 'explorer' && (
          <ExplorerPage
            key={destination.activation}
            target={destination.target}
            snapshots={viewOptions}
            onTargetConsumed={consumeTarget}
            onFollowLatest={() => navigate('explorer')}
          />
        )}
        {destination.page === 'insights' && (
          <InsightsPage
            key={destination.activation}
            snapshots={viewOptions}
            onOpenOverview={() => navigate('overview')}
            onFollowLatest={() => navigate('insights')}
            onOpenExplorer={(entry) =>
              navigateToSnapshot(rankedExplorerTarget(viewOptions.selection, entry))
            }
          />
        )}
      </main>
    </>
  )
}

function insightsTarget(
  label: string,
  scanId: string
): {
  label: string
  destination: SnapshotNavigationTarget
} {
  return { label, destination: { view: 'insights', selection: { mode: 'explicit', scanId } } }
}

function savedTarget(
  label: string,
  scanId: string,
  entry?: { entryId: string; parentId: string; type: 'file' | 'directory' }
): {
  label: string
  destination: SnapshotNavigationTarget
} {
  return {
    label,
    destination: {
      view: 'explorer',
      selection: { mode: 'explicit', scanId },
      entry: entry && { ...entry, scanId }
    }
  }
}

test('an explicit selection of Latest keeps historical navigation and entry selection through publication', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha', 1)
  const beta = publishedFixture('scan-b', 'Beta')
  const { api, restore, publish, changeHistory } = historicalApp(alpha, beta)
  restore(alpha)
  render(<HistoricalExplorer targets={[savedTarget('Open Alpha', 'scan-a')]} />)
  fireEvent.click(button('Open Alpha'))
  await chart('Alpha')
  expect(screen.getByText('Explicit snapshot')).toBeVisible()
  expect(screen.queryByText('Historical snapshot')).not.toBeInTheDocument()
  const context = screen.getByLabelText('Snapshot details')
  expect(context).toHaveTextContent('/scans/Alpha')
  expect(context.querySelector('time')).toHaveAttribute('datetime', timestamp)
  expect(screen.getByText('Incomplete snapshot: known sizes may be partial.')).toBeVisible()
  fireEvent.click(button('Expand Alpha'))
  const tree = panel('Directory Tree')
  const nested = await tree.findByRole('button', { name: 'Nested' })
  fireEvent.doubleClick(panel('Treemap').getByRole('button', { name: 'Nested, directory, 2 KB' }))
  await chart('Nested')
  expect(nested).toHaveAttribute('aria-current', 'location')
  fireEvent.click(await panel('Directory Contents').findByRole('button', { name: 'inside.bin' }))
  await panel('Details').findByText('/scans/Alpha/Nested/inside.bin')
  await act(async () => {
    publish(beta)
    changeHistory()
  })
  expect(screen.getByText('Historical snapshot')).toBeVisible()
  expect(panel('Details').getByText('/scans/Alpha/Nested/inside.bin')).toBeVisible()
  expect(nested).toHaveAttribute('aria-current', 'location')
  expect(api.prepareSnapshotSelection).toHaveBeenCalledOnce()

  fireEvent.click(button('Back'))
  await chart('Alpha')
  fireEvent.click(button('Forward'))
  await chart('Nested')
  fireEvent.click(button('Up'))
  await chart('Alpha')
  fireEvent.click(nested)
  await chart('Nested')
  const breadcrumb = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
  fireEvent.click(breadcrumb.getByRole('button', { name: 'Alpha' }))
  await chart('Alpha')

  fireEvent.click(button('Follow Latest'))
  await chart('Beta')
  expect(screen.getByText('Following Latest')).toBeVisible()
  expect(screen.queryByText('Historical snapshot')).not.toBeInTheDocument()
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  expect(button('Back')).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('main')).toHaveFocus()
})

test('opens an exact historical entry and rejects a target from a different scan with the same IDs', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha', 0, 4, true)
  const beta = publishedFixture('scan-b', 'Beta')
  const { api, restore } = historicalApp(alpha, beta)
  restore(beta)
  const exact = savedTarget('Open historical file', 'scan-a', {
    entryId: 'nested',
    parentId: 'leaf',
    type: 'file'
  })
  const stale = {
    label: 'Open mismatched file',
    destination: {
      ...exact.destination,
      view: 'explorer',
      entry: {
        scanId: 'scan-b',
        entryId: 'nested',
        parentId: 'leaf',
        type: 'file'
      }
    } as const
  }
  render(<HistoricalExplorer targets={[exact, stale]} />)
  fireEvent.click(button(exact.label))
  await chart('Leaf')
  expect(screen.getByText('Historical snapshot')).toBeVisible()
  expect(panel('Details').getByText(rankedFilePath)).toBeVisible()
  expect(api.getScanEntry.mock.calls.every(([request]) => request.scanId === 'scan-a')).toBe(true)
  api.getScanEntry.mockClear()
  fireEvent.click(button(stale.label))
  await chart('Alpha')
  expect(screen.getByRole('alert')).toHaveTextContent('The scan has changed')
  expect(api.getScanEntry).not.toHaveBeenCalled()
})

test('drops late entry and selection results across rapid historical transitions with identical IDs', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha')
  const beta = publishedFixture('scan-b', 'Beta')
  const gamma = publishedFixture('scan-c', 'Gamma')
  const { api, restore } = historicalApp(alpha, beta, gamma)
  restore(gamma)
  render(
    <HistoricalExplorer
      targets={[
        savedTarget('Open Alpha', 'scan-a'),
        savedTarget('Open Beta', 'scan-b'),
        savedTarget('Open Gamma', 'scan-c')
      ]}
    />
  )
  fireEvent.click(button('Open Alpha'))
  await chart('Alpha')
  const details = Promise.withResolvers<ScannerIpcResult<FileEntry>>()
  api.getScanEntry.mockReturnValueOnce(details.promise)
  fireEvent.click(await panel('Directory Contents').findByRole('button', { name: 'Alpha.txt' }))
  await waitFor(() =>
    expect(api.getScanEntry).toHaveBeenCalledWith({ scanId: 'scan-a', entryId: 'report' })
  )
  const prepare = api.prepareSnapshotSelection.getMockImplementation()!
  const delayed = Promise.withResolvers<void>()
  api.prepareSnapshotSelection.mockImplementationOnce(async (request) => {
    const result = await prepare(request)
    await delayed.promise
    return result
  })
  fireEvent.click(button('Open Beta'))
  expect(screen.getByRole('status')).toHaveTextContent('Loading snapshot')
  fireEvent.click(button('Open Gamma'))
  await chart('Gamma')
  await act(async () => {
    delayed.resolve()
    details.resolve({
      ok: true,
      value: alpha.database.getScanEntry({ scanId: 'scan-a', entryId: 'report' })
    })
  })
  expect(api.adoptSnapshotSelection.mock.calls.map(([request]) => request.ticket)).toEqual([
    'scan-a',
    'scan-c'
  ])
  expect(panel('Details').getByText('No item selected')).toBeVisible()
  expect(screen.queryByText('Alpha.txt')).not.toBeInTheDocument()
  expect(screen.queryByText('Beta.txt')).not.toBeInTheDocument()
})

test('keeps a missing explicit selection visible and offers a deliberate return to Latest', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha')
  const { api, restore } = historicalApp(alpha)
  restore(alpha)
  render(<HistoricalExplorer targets={[savedTarget('Open missing', 'missing')]} />)
  fireEvent.click(button('Open missing'))
  expect(await screen.findByRole('alert')).toHaveTextContent('This saved scan no longer exists.')
  expect(api.getScanSnapshot).not.toHaveBeenCalled()
  expect(api.listScanDirectory).not.toHaveBeenCalled()
  fireEvent.click(button('Follow Latest'))
  await chart('Alpha')
})
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

async function recentAction(view: 'Explorer' | 'Insights', path: string): Promise<HTMLElement> {
  const metadata = await panel('Recent Scans').findByText(path)
  return within(metadata.closest('li')!).getByRole('button', {
    name: new RegExp(`^Open in ${view} for`)
  })
}

test('opens an older Recent Scans row at its Explorer root and releases it on exit', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha')
  const beta = publishedFixture('scan-b', 'Beta')
  const { api, restore } = historicalApp(alpha, beta)
  restore(alpha)
  restore(beta)
  render(<App />)
  const action = await recentAction('Explorer', '/scans/Alpha')
  expect(api.prepareSnapshotSelection).not.toHaveBeenCalled()
  expect(api.getScanSnapshot).not.toHaveBeenCalled()
  action.focus()
  fireEvent.click(action)
  await chart('Alpha')
  expect(screen.getByRole('heading', { name: 'Storage Explorer' })).toHaveFocus()
  expect(api.prepareSnapshotSelection).toHaveBeenCalledExactlyOnceWith({
    view: 'explorer',
    selection: { mode: 'explicit', scanId: 'scan-a' }
  })
  open('Overview')
  await recentAction('Explorer', '/scans/Alpha')
  expect(api.releaseSnapshotSelection).toHaveBeenCalledExactlyOnceWith({ view: 'explorer' })
  expect(api.listScanHistory).toHaveBeenCalledTimes(2)
  open('Explorer')
  await chart('Beta')
  expect(api.prepareSnapshotSelection).toHaveBeenLastCalledWith({
    view: 'explorer',
    selection: { mode: 'follow-latest' }
  })
})

test.each(['Explorer', 'Insights'] as const)(
  'opens Latest from Recent Scans in explicit %s even if a publication arrives during adoption',
  async (view) => {
    const beta = publishedFixture('scan-b', 'Beta')
    const gamma = publishedFixture('scan-c', 'Gamma')
    const { api, restore, publish } = historicalApp(beta, gamma)
    restore(beta)
    const adopt =
      Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['adoptSnapshotSelection']>>>()
    api.adoptSnapshotSelection.mockReturnValueOnce(adopt.promise)
    render(<App />)
    const action = await recentAction(view, '/scans/Beta')
    expect(within(action.closest('li')!).getByText('Latest')).toBeVisible()
    fireEvent.click(action)
    await waitFor(() => expect(api.adoptSnapshotSelection).toHaveBeenCalledOnce())
    act(() => publish(gamma))
    expect(api.listScanDirectory).not.toHaveBeenCalled()
    expect(api.getInsightsSummary).not.toHaveBeenCalled()
    await act(async () =>
      adopt.resolve({ ok: true, value: view === 'Explorer' ? beta.snapshot : null })
    )
    if (view === 'Explorer') await chart('Beta')
    else expect(await panel('Selected snapshot').findByText('/scans/Beta')).toBeVisible()
    expect(screen.getByText('Historical snapshot')).toBeVisible()
    expect(api.prepareSnapshotSelection).toHaveBeenCalledExactlyOnceWith({
      view: view.toLowerCase(),
      selection: { mode: 'explicit', scanId: 'scan-b' }
    })
    fireEvent.click(button('Follow Latest'))
    if (view === 'Explorer') await chart('Gamma')
    else expect(await panel('Published scan').findByText('/scans/Gamma')).toBeVisible()
  }
)

test.each(['files', 'directories'] as const)(
  'opens older Insights from Recent Scans and hands off ranked %s to the exact Explorer snapshot',
  async (kind) => {
    const alpha = publishedFixture('scan-a', 'Alpha', 0, kind === 'files' ? 101 : 1, true)
    const beta = publishedFixture('scan-b', 'Beta')
    const { api, restore } = historicalApp(alpha, beta)
    restore(alpha)
    restore(beta)
    render(<App />)
    fireEvent.click(await recentAction('Insights', '/scans/Alpha'))
    expect(await panel('Selected snapshot').findByText('/scans/Alpha')).toBeVisible()
    expect(screen.getByText('Historical snapshot')).toBeVisible()
    expect(api.getInsightsSummary).toHaveBeenCalledExactlyOnceWith({ scanId: 'scan-a' })
    const path = kind === 'files' ? rankedFilePath : rankedDirectoryPath
    fireEvent.click(await rankedAction(kind, path))
    await chart('Leaf')
    expect(api.prepareSnapshotSelection.mock.calls).toEqual([
      [{ view: 'insights', selection: { mode: 'explicit', scanId: 'scan-a' } }],
      [{ view: 'explorer', selection: { mode: 'explicit', scanId: 'scan-a' } }]
    ])
    expect(api.releaseSnapshotSelection).toHaveBeenCalledExactlyOnceWith({ view: 'insights' })
    if (kind === 'files') {
      expect(panel('Directory Contents').getByText(/Page 2 of 2.*102 entries/)).toBeVisible()
      expect(panel('Details').getByText(path)).toBeVisible()
    } else {
      expect(panel('Directory Tree').getByRole('button', { name: 'Leaf' })).toHaveAttribute(
        'aria-current',
        'location'
      )
    }
  }
)

test.each(['Explorer', 'Insights'] as const)(
  'shows the missing explicit %s selection when a Recent Scans row is pruned before opening',
  async (view) => {
    const alpha = publishedFixture('scan-a', 'Alpha')
    const beta = publishedFixture('scan-b', 'Beta')
    const { api, restore } = historicalApp(alpha, beta)
    restore(alpha)
    restore(beta)
    api.prepareSnapshotSelection.mockResolvedValueOnce({
      ok: false,
      error: { code: 'SNAPSHOT_EXPIRED', message: 'This saved scan no longer exists.' }
    })
    render(<App />)
    fireEvent.click(await recentAction(view, '/scans/Alpha'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no longer exists|snapshot is unavailable/
    )
    expect(api.adoptSnapshotSelection).not.toHaveBeenCalled()
    expect(api.getScanSnapshot).not.toHaveBeenCalled()
    expect(api.listScanDirectory).not.toHaveBeenCalled()
    expect(api.getInsightsSummary).not.toHaveBeenCalled()
    expect(button('Follow Latest')).toBeVisible()
  }
)

test('ignores a superseded Recent Scans navigation when its preparation arrives late', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha')
  const beta = publishedFixture('scan-b', 'Beta')
  const { api, restore } = historicalApp(alpha, beta)
  restore(alpha)
  restore(beta)
  const slow = Promise.withResolvers<void>()
  const prepare = api.prepareSnapshotSelection.getMockImplementation()!
  api.prepareSnapshotSelection.mockImplementationOnce(async (request) => {
    const result = await prepare(request)
    await slow.promise
    return result
  })
  render(<App />)
  fireEvent.click(await recentAction('Insights', '/scans/Alpha'))
  await waitFor(() => expect(api.prepareSnapshotSelection).toHaveBeenCalledOnce())
  open('Overview')
  fireEvent.click(await recentAction('Explorer', '/scans/Beta'))
  await chart('Beta')
  await act(async () => slow.resolve())
  expect(api.adoptSnapshotSelection).toHaveBeenCalledExactlyOnceWith({
    view: 'explorer',
    ticket: 'scan-b'
  })
  expect(api.releaseSnapshotSelection).toHaveBeenCalledWith({ view: 'insights' })
  expect(api.getInsightsSummary).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: 'Storage Explorer' })).toBeVisible()
})

test('keeps explicit Insights and its ranking page through publication, then resets on Follow Latest', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha', 1, 20)
  const beta = publishedFixture('scan-b', 'Beta')
  const { api, restore, publish, changeHistory } = historicalApp(alpha, beta)
  restore(alpha)
  const adopt = Promise.withResolvers<ScannerIpcResult<null>>()
  api.adoptSnapshotSelection.mockReturnValueOnce(adopt.promise)
  render(<HistoricalExplorer targets={[insightsTarget('Analyze Alpha', 'scan-a')]} />)
  fireEvent.click(button('Analyze Alpha'))
  expect(await screen.findByRole('status')).toHaveTextContent('Loading saved scan')
  await waitFor(() => expect(api.adoptSnapshotSelection).toHaveBeenCalledOnce())
  expect(api.getInsightsSummary).not.toHaveBeenCalled()
  expect(api.getInsightsCategories).not.toHaveBeenCalled()
  await act(async () => adopt.resolve({ ok: true, value: null }))
  const context = panel('Selected snapshot')
  expect(await context.findByText('/scans/Alpha')).toBeVisible()
  expect(context.getByText('Some items couldn’t be scanned.')).toBeVisible()
  expect(
    screen.getByRole('region', { name: 'Selected snapshot' }).querySelector('time')
  ).toHaveAttribute('datetime', alpha.snapshot.completedAt)
  expect(screen.queryByText('Historical snapshot')).not.toBeInTheDocument()
  const files = panel('Largest files')
  await files.findByText('1–10 of 20 ranked files')
  fireEvent.click(files.getByRole('button', { name: 'Next file ranking page' }))
  await files.findByText('11–20 of 20 ranked files')
  await act(async () => {
    publish(beta)
    changeHistory()
  })
  expect(screen.getByText('Historical snapshot')).toBeVisible()
  expect(context.getByText('/scans/Alpha')).toBeVisible()
  expect(files.getByText('11–20 of 20 ranked files')).toBeVisible()
  expect(api.prepareSnapshotSelection).toHaveBeenCalledOnce()
  expect(api.getInsightsSummary).toHaveBeenCalledExactlyOnceWith({ scanId: 'scan-a' })
  fireEvent.click(button('Follow Latest'))
  expect(await panel('Published scan').findByText('/scans/Beta')).toBeVisible()
  expect(screen.queryByText('Historical snapshot')).not.toBeInTheDocument()
  expect(await panel('Largest files').findByText('1–2 of 2 ranked files')).toBeVisible()
  expect(screen.getByRole('main')).toHaveFocus()
})

test.each(['files', 'directories'] as const)(
  'hands off historical ranked %s to the exact adopted Explorer snapshot',
  async (kind) => {
    const alpha = publishedFixture('scan-a', 'Alpha', 0, kind === 'files' ? 205 : 1, true)
    const beta = publishedFixture('scan-b', 'Beta')
    const gamma = publishedFixture('scan-c', 'Gamma')
    const { api, restore, publish } = historicalApp(alpha, beta, gamma)
    restore(beta)
    render(<HistoricalExplorer targets={[insightsTarget('Analyze archive', 'scan-a')]} />)
    fireEvent.click(button('Analyze archive'))
    expect(await screen.findByText('Historical snapshot')).toBeVisible()
    const path = kind === 'files' ? rankedFilePath : rankedDirectoryPath
    const open = await rankedAction(kind, path)
    const adopt =
      Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['adoptSnapshotSelection']>>>()
    api.adoptSnapshotSelection.mockReturnValueOnce(adopt.promise)
    open.focus()
    fireEvent.click(open)
    expect(screen.getByRole('heading', { name: 'Storage Explorer' })).toHaveFocus()
    expect(api.releaseSnapshotSelection).not.toHaveBeenCalled()
    act(() => publish(gamma))
    expect(api.releaseSnapshotSelection).not.toHaveBeenCalled()
    expect(api.getScanEntry).not.toHaveBeenCalled()
    await act(async () => adopt.resolve({ ok: true, value: alpha.snapshot }))
    await chart('Leaf')
    expect(api.prepareSnapshotSelection).toHaveBeenLastCalledWith({
      view: 'explorer',
      selection: { mode: 'explicit', scanId: 'scan-a' }
    })
    expect(api.releaseSnapshotSelection).toHaveBeenCalledExactlyOnceWith({ view: 'insights' })
    expect(api.getScanEntry.mock.calls.every(([request]) => request.scanId === 'scan-a')).toBe(true)
    if (kind === 'files') {
      const contents = panel('Directory Contents')
      expect(contents.getByText('Page 3 of 3 · 206 entries')).toBeVisible()
      expect(contents.getByRole('button', { name: 'Ω-target.bin' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(panel('Details').getByText(path)).toBeVisible()
    } else {
      const breadcrumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
      expect(breadcrumbs.getByText('Leaf')).toHaveAttribute('aria-current', 'page')
      expect(panel('Directory Tree').getByRole('button', { name: 'Leaf' })).toHaveAttribute(
        'aria-current',
        'location'
      )
    }
  }
)

test('discards a superseded Insights selection and late section data after returning to the same ID', async () => {
  const alpha = publishedFixture('scan-a', 'Alpha')
  const beta = publishedFixture('scan-b', 'Beta')
  const gamma = publishedFixture('scan-c', 'Gamma')
  const { api, restore } = historicalApp(alpha, beta, gamma)
  restore(gamma)
  const late = Promise.withResolvers<ScannerIpcResult<InsightsCategories>>()
  api.getInsightsCategories.mockReturnValueOnce(late.promise)
  render(
    <HistoricalExplorer
      targets={[
        insightsTarget('Analyze Alpha', 'scan-a'),
        insightsTarget('Analyze Beta', 'scan-b'),
        insightsTarget('Analyze Gamma', 'scan-c')
      ]}
    />
  )
  fireEvent.click(button('Analyze Alpha'))
  await panel('Selected snapshot').findByText('/scans/Alpha')
  await waitFor(() =>
    expect(api.getInsightsCategories).toHaveBeenCalledExactlyOnceWith({ scanId: 'scan-a' })
  )
  const slow = Promise.withResolvers<void>()
  const prepare = api.prepareSnapshotSelection.getMockImplementation()!
  api.prepareSnapshotSelection.mockImplementationOnce(async (request) => {
    const resolution = await prepare(request)
    await slow.promise
    return resolution
  })
  fireEvent.click(button('Analyze Beta'))
  expect(panel('Selected snapshot').queryByText('/scans/Alpha')).not.toBeInTheDocument()
  fireEvent.click(button('Analyze Gamma'))
  await panel('Selected snapshot').findByText('/scans/Gamma')
  fireEvent.click(button('Analyze Alpha'))
  await panel('Selected snapshot').findByText('/scans/Alpha')
  await panel('File categories').findByRole('figure')
  await act(async () => {
    slow.resolve()
    late.resolve({ ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Previous visit' } })
  })
  expect(api.adoptSnapshotSelection.mock.calls.map(([request]) => request.ticket)).toEqual([
    'scan-a',
    'scan-c',
    'scan-a'
  ])
  expect(panel('File categories').getByRole('figure')).toBeVisible()
  expect(panel('File categories').queryByRole('alert')).not.toBeInTheDocument()
})

test.each(['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE'] as const)(
  'keeps a failed explicit Insights selection visible for %s',
  async (code) => {
    const alpha = publishedFixture('scan-a', 'Alpha')
    const { api, restore } = historicalApp(alpha)
    restore(alpha)
    api.prepareSnapshotSelection.mockResolvedValueOnce({
      ok: false,
      error: { code, message: 'Saved snapshot is unavailable.' }
    })
    render(<HistoricalExplorer targets={[insightsTarget('Analyze archive', 'broken')]} />)
    fireEvent.click(button('Analyze archive'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This saved snapshot is unavailable.'
    )
    expect(api.getInsightsSummary).not.toHaveBeenCalled()
    expect(api.getScanSnapshot).not.toHaveBeenCalled()
    fireEvent.click(button('Follow Latest'))
    expect(await panel('Published scan').findByText('/scans/Alpha')).toBeVisible()
  }
)

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

test('Explorer waits for Main adoption, retains the same lease across history-only changes, and releases on exit', async () => {
  const { api, restore, changeHistory } = mockApp()
  restore(publishedFixture('scan-a', 'Alpha'))
  const adoption = Promise.withResolvers<ScannerIpcResult<null>>()
  api.adoptSnapshotSelection.mockReturnValueOnce(adoption.promise)
  render(<App />)
  open('Explorer')
  expect(screen.getByRole('heading', { name: 'Storage Explorer' })).toBeVisible()
  await waitFor(() => expect(api.adoptSnapshotSelection).toHaveBeenCalledOnce())
  expect(api.listScanDirectory).not.toHaveBeenCalled()
  expect(api.getScanDirectoryTreemap).not.toHaveBeenCalled()
  await act(async () => adoption.resolve({ ok: true, value: null }))
  await chart('Alpha')
  await act(async () => changeHistory())
  expect(api.prepareSnapshotSelection).toHaveBeenCalledExactlyOnceWith({
    view: 'explorer',
    selection: { mode: 'follow-latest' }
  })
  open('Overview')
  expect(api.releaseSnapshotSelection).toHaveBeenCalledExactlyOnceWith({ view: 'explorer' })
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
