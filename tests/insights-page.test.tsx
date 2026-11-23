import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi, type Mocked } from 'vitest'
import App from '../src/renderer/src/App'
import { CategoryDonut } from '../src/renderer/src/features/insights/CategoryDonut'
import { InsightsPage } from '../src/renderer/src/pages/InsightsPage'
import {
  DEFAULT_INSIGHTS_RANKING_PAGE_SIZE,
  INSIGHTS_RANKING_LIMIT,
  INSIGHTS_SIZE_BUCKETS,
  type InsightsCategories,
  type InsightsExtensionPage,
  type InsightsExtensionRow,
  type InsightsFileCategory,
  type InsightsObservations,
  type InsightsRankedEntry,
  type InsightsRankingPage,
  type InsightsRankingRequest,
  type InsightsSizeDistribution,
  type InsightsSummary
} from '../src/shared/insights'
import type { ScannerIpcResult, ScanStateSnapshot, SpaceLensAPI } from '../src/shared/ipc'
import type { ScanStatus } from '../src/shared/scan'
import type { ScanSnapshotAvailability } from '../src/shared/snapshot'

const completedAt = '2026-11-19T12:45:00+02:00'
const regularScan: InsightsSummary = {
  scanId: 'scan-a',
  rootPath: `C:\\Fixtures\\Notes & Projects\\${'a'.repeat(190)}`,
  completedAt,
  summary: { fileCount: 3, directoryCount: 1, totalBytes: 180, errorCount: 0 },
  incomplete: false
}
const replacement: InsightsSummary = {
  ...regularScan,
  scanId: 'scan-b',
  rootPath: 'C:\\Fixtures\\New folder',
  completedAt: '2026-11-20T13:40:00Z'
}
const noSnapshot = { snapshot: null, unavailable: null } satisfies ScanSnapshotAvailability
let publication: InsightsSummary | null
let api: Mocked<SpaceLensAPI>
let emit: (update: ScanStateSnapshot) => void
let listeners: Set<(update: ScanStateSnapshot) => void>

function success<T>(value: T): ScannerIpcResult<T> {
  return { ok: true, value }
}

function categoriesFor(
  scan: InsightsSummary,
  category: InsightsFileCategory = 'images'
): InsightsCategories {
  const { fileCount, totalBytes: knownBytes } = scan.summary
  const totals = { fileCount, knownBytes, unknownSizeCount: 0 }
  return {
    scanId: scan.scanId,
    incomplete: scan.incomplete,
    totals,
    categories: fileCount > 0 ? [{ ...totals, category }] : []
  }
}

function extensionPage(
  scan: InsightsSummary,
  rows: readonly InsightsExtensionRow[],
  offset = 0,
  limit = 20
): InsightsExtensionPage {
  const extensions = rows.slice(offset, offset + limit)
  const next = offset + extensions.length
  return {
    scanId: scan.scanId,
    incomplete: scan.incomplete,
    totalCount: rows.length,
    totals: {
      fileCount: scan.summary.fileCount,
      knownBytes: scan.summary.totalBytes,
      unknownSizeCount: rows.reduce((sum, row) => sum + row.unknownSizeCount, 0)
    },
    extensions,
    nextOffset: next < rows.length ? next : null
  }
}

function distributionFor(
  scan: InsightsSummary,
  ...sizes: (number | null)[]
): InsightsSizeDistribution {
  const buckets = INSIGHTS_SIZE_BUCKETS.map(({ id, minBytes }, index) => {
    const upper = INSIGHTS_SIZE_BUCKETS[index + 1]?.minBytes ?? Infinity
    const measured = sizes.filter(
      (size): size is number => size !== null && size >= minBytes && size < upper
    )
    return {
      id,
      fileCount: measured.length,
      knownBytes: measured.reduce((sum, size) => sum + size, 0)
    }
  })
  const unknownSizeCount = sizes.filter((size) => size === null).length
  return {
    scanId: scan.scanId,
    incomplete: scan.incomplete,
    knownSizeCount: sizes.length - unknownSizeCount,
    totals: { fileCount: sizes.length, knownBytes: scan.summary.totalBytes, unknownSizeCount },
    buckets
  }
}

function rankedEntries(
  scan: InsightsSummary,
  type: InsightsRankedEntry['type']
): InsightsRankedEntry[] {
  const available = type === 'file' ? scan.summary.fileCount : scan.summary.directoryCount - 1
  return Array.from({ length: Math.min(available, INSIGHTS_RANKING_LIMIT) }, (_, index) => {
    const name = `${type}-${String(index + 1).padStart(2, '0')}`
    return {
      id: name,
      scanId: scan.scanId,
      parentId: 'root',
      name,
      path: `${scan.rootPath}\\${name}`,
      type,
      bytes: index === 0 ? scan.summary.totalBytes : 0
    }
  })
}

function rankingPage(
  scan: InsightsSummary,
  ranked: readonly InsightsRankedEntry[],
  offset = 0,
  limit = DEFAULT_INSIGHTS_RANKING_PAGE_SIZE
): InsightsRankingPage {
  const entries = ranked.slice(offset, offset + limit)
  return {
    scanId: scan.scanId,
    incomplete: scan.incomplete,
    entries,
    offset,
    limit,
    totalCount: ranked.length,
    nextOffset: offset + entries.length < ranked.length ? offset + entries.length : null
  }
}

function readRanking(type: InsightsRankedEntry['type']) {
  return async ({
    scanId,
    offset,
    limit
  }: InsightsRankingRequest): Promise<ScannerIpcResult<InsightsRankingPage>> => {
    if (publication?.scanId !== scanId) {
      return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture ID' } }
    }
    return success(rankingPage(publication, rankedEntries(publication, type), offset, limit))
  }
}

function metadata(scan: InsightsSummary | null): ScannerIpcResult<ScanSnapshotAvailability> {
  if (!scan) return success(noSnapshot)
  const { scanId, rootPath, completedAt, summary, incomplete } = scan
  return success({
    snapshot: {
      entries: { scanId, rootEntryId: 'root' },
      root: {
        scanId,
        id: 'root',
        parentId: null,
        path: rootPath,
        name: rootPath.split('\\').at(-1)!,
        type: 'directory',
        sizeBytes: null,
        aggregatedSizeBytes: summary.totalBytes,
        createdAt: null,
        modifiedAt: null
      },
      entryCount: summary.fileCount + summary.directoryCount,
      completedAt,
      summary,
      incomplete
    },
    unavailable: null
  })
}

function update(revision: number, status?: ScanStatus): ScanStateSnapshot {
  const latestCompleted = publication && {
    id: publication.scanId,
    path: publication.rootPath,
    completedAt: publication.completedAt,
    ...publication.summary
  }
  const scanId = status === 'completed' ? publication!.scanId : replacement.scanId
  const session = {
    id: scanId,
    rootPath: replacement.rootPath,
    startedAt: completedAt,
    summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
  }
  return {
    revision,
    latestCompleted,
    publicationStatus: 'ready',
    state: status
      ? {
          session:
            status === 'running'
              ? { ...session, status, finishedAt: null }
              : { ...session, status, finishedAt: replacement.completedAt },
          progress: {
            scanId,
            processedFileCount: 0,
            processedDirectoryCount: 0,
            processedBytes: 0,
            currentPath: null
          },
          failure: status === 'failed' ? { name: 'Error', code: null, message: 'Failed' } : null
        }
      : null
  }
}

function openInsights(): ReturnType<typeof render> {
  return render(
    <StrictMode>
      <InsightsPage onOpenOverview={vi.fn()} />
    </StrictMode>
  )
}

function scanPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Published scan' })
}

function categoryPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'File categories' })
}

async function findCategory(label: string): Promise<HTMLElement> {
  return waitFor(() => within(categoryPanel()).getByText(label))
}

const extensionsPanel = (): HTMLElement => screen.getByRole('region', { name: 'File extensions' })
const distributionPanel = (): HTMLElement =>
  screen.getByRole('region', { name: 'File size distribution' })

function summaryCards(): HTMLElement {
  return screen.getByRole('region', { name: 'Scan summary' })
}

beforeEach(() => {
  publication = null
  listeners = new Set()
  emit = (notification) => act(() => listeners.forEach((listener) => listener(notification)))
  api = {
    getAppInfo: vi.fn(),
    getScanState: vi.fn(async () => success(update(0))),
    getScanSnapshot: vi.fn(async () => metadata(publication)),
    getScanEntry: vi.fn(),
    listScanDirectory: vi.fn(),
    getScanDirectoryTreemap: vi.fn(),
    getInsightsSummary: vi.fn(async ({ scanId }) => {
      if (publication?.scanId !== scanId) {
        return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture ID' } }
      }
      return success(publication)
    }),
    getInsightsCategories: vi.fn(async ({ scanId }) => {
      if (publication?.scanId !== scanId) {
        return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture ID' } }
      }
      return success(
        categoriesFor(publication, scanId === regularScan.scanId ? 'images' : 'documents')
      )
    }),
    getInsightsSizeDistribution: vi.fn(async ({ scanId }) => {
      if (publication?.scanId !== scanId) {
        return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture ID' } }
      }
      const { fileCount, totalBytes } = publication.summary
      return success(
        distributionFor(
          publication,
          ...Array.from({ length: fileCount }, (_, index) => (index ? 0 : totalBytes))
        )
      )
    }),
    getInsightsObservations: vi.fn(async ({ scanId }) => {
      if (publication?.scanId !== scanId) {
        return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture ID' } }
      }
      return success({ scanId, incomplete: publication.incomplete, observations: [] })
    }),
    listInsightsExtensions: vi.fn(async ({ scanId, offset, limit }) => {
      if (publication?.scanId !== scanId) {
        return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture ID' } }
      }
      const original = scanId === regularScan.scanId
      const category = original ? 'images' : 'documents'
      const rows = categoriesFor(publication, category).categories.map((row) => ({
        ...row,
        extension: original ? 'jpg' : 'md'
      }))
      return success(extensionPage(publication, rows, offset, limit))
    }),
    listInsightsLargestFiles: vi.fn(readRanking('file')),
    listInsightsLargestDirectories: vi.fn(readRanking('directory')),
    onScanStateChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    selectScanDirectory: vi.fn(),
    startScan: vi.fn(),
    cancelScan: vi.fn()
  }
  vi.stubGlobal('spaceLens', api)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('starts on Overview and navigates between Insights, Explorer and Overview with one active item', async () => {
  render(<App />)
  const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }))
  const overview = nav.getByRole('button', { name: 'Overview' })
  const insights = nav.getByRole('button', { name: 'Insights' })
  expect(overview).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('heading', { name: 'Storage Overview' })).toBeVisible()
  expect(api.getScanSnapshot).not.toHaveBeenCalled()

  insights.focus()
  fireEvent.click(insights)
  expect(insights).toHaveFocus()
  expect(insights).toHaveAttribute('aria-current', 'page')
  expect(overview).not.toHaveAttribute('aria-current')
  expect(screen.getByRole('heading', { level: 2, name: 'Storage Insights' })).toBeVisible()
  await screen.findByRole('heading', { name: 'No completed scan' })
  const returnButton = within(scanPanel()).getByRole('button', { name: 'Go to Overview' })
  returnButton.focus()
  expect(returnButton).toHaveFocus()
  fireEvent.click(returnButton)
  expect(screen.getByRole('main', { name: 'Overview' })).toHaveFocus()
  expect(overview).toHaveAttribute('aria-current', 'page')

  const explorer = nav.getByRole('button', { name: 'Explorer' })
  fireEvent.click(explorer)
  expect(explorer).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('main', { name: 'Explorer' })).toBeVisible()
  fireEvent.click(insights)
  expect(insights).toHaveAttribute('aria-current', 'page')
  await screen.findByRole('heading', { name: 'No completed scan' })
  expect(api.getInsightsSummary).not.toHaveBeenCalled()
  expect(api.getInsightsCategories).not.toHaveBeenCalled()
  expect(api.getInsightsObservations).not.toHaveBeenCalled()
})

test('announces loading while resolving metadata and distinguishes an absent publication', async () => {
  const pending = Promise.withResolvers<ScannerIpcResult<ScanSnapshotAvailability>>()
  api.getScanSnapshot.mockReturnValue(pending.promise)
  openInsights()
  expect(within(scanPanel()).getByRole('status')).toHaveTextContent('Loading saved scan')
  await act(async () => pending.resolve(metadata(null)))
  expect(screen.getByRole('heading', { name: 'No completed scan' })).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(api.getInsightsSummary).not.toHaveBeenCalled()
  expect(api.getInsightsCategories).not.toHaveBeenCalled()
})

test('shows scoped completion details for a publication restored with an idle scanner', async () => {
  publication = regularScan
  openInsights()
  const path = await screen.findByText(regularScan.rootPath)
  expect(path).toBeVisible()
  expect(path).toHaveClass('[overflow-wrap:anywhere]')
  expect(within(scanPanel()).getByText('Root folder')).toBeVisible()
  expect(within(scanPanel()).getByText('Completed')).toBeVisible()
  expect(scanPanel().querySelector('time')).toHaveAttribute('datetime', completedAt)
  const localDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(
    new Date(completedAt)
  )
  expect(scanPanel().querySelector('time')).toHaveTextContent(localDate)
  expect(await within(categoryPanel()).findByText('Images')).toBeVisible()
  emit(update(1))
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(api.getInsightsSummary).toHaveBeenCalledExactlyOnceWith({ scanId: regularScan.scanId })
  expect(api.getInsightsCategories).toHaveBeenCalledExactlyOnceWith({ scanId: regularScan.scanId })
  expect(api.getInsightsSizeDistribution).toHaveBeenCalledExactlyOnceWith({
    scanId: regularScan.scanId
  })
  expect(api.listInsightsExtensions).toHaveBeenCalledExactlyOnceWith({
    scanId: regularScan.scanId,
    offset: 0,
    limit: 20
  })
  expect(api.getScanState).not.toHaveBeenCalled()
  expect(await screen.findByText('No notable patterns met the observation rules.')).toBeVisible()
  expect(api.getInsightsObservations).toHaveBeenCalledExactlyOnceWith({
    scanId: regularScan.scanId
  })
  for (const query of [api.getScanEntry, api.listScanDirectory, api.getScanDirectoryTreemap]) {
    expect(query).not.toHaveBeenCalled()
  }
})

test('renders a completed zero-file scan and its completion metadata', async () => {
  publication = { ...regularScan, summary: { ...regularScan.summary, fileCount: 0, totalBytes: 0 } }
  openInsights()
  expect(await screen.findByText('No files were found in this scan.')).toBeVisible()
  expect(screen.getByText(regularScan.rootPath)).toBeVisible()
  expect(scanPanel().querySelector('time')).toHaveAttribute('datetime', completedAt)
  expect(screen.queryByText('No completed scan')).not.toBeInTheDocument()
  expect(
    within(summaryCards())
      .getAllByRole('definition')
      .map((metric) => metric.textContent)
  ).toEqual(['0 B', '0', '1', '0'])
  expect(await within(categoryPanel()).findByText('No known bytes to chart.')).toBeVisible()
  expect(categoryPanel().querySelector('[data-category]')).toBeNull()
})

test('retains completed scan context when some filesystem items could not be read', async () => {
  publication = {
    ...regularScan,
    incomplete: true,
    summary: { ...regularScan.summary, errorCount: 1 }
  }
  openInsights()
  expect(await screen.findByText('Some items couldn’t be scanned.')).toBeVisible()
  expect(screen.getByText(/Insights reflects the items/)).toBeVisible()
  expect(screen.getByText(regularScan.rootPath)).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('explains a storage failure and allows one explicit retry while moving focus predictably', async () => {
  const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = {
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'SQLite fixture unavailable' }
  } as const
  const pending = Promise.withResolvers<ScannerIpcResult<ScanSnapshotAvailability>>()
  api.getScanSnapshot.mockResolvedValueOnce(error).mockReturnValueOnce(pending.promise)
  publication = regularScan
  openInsights()
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('SpaceLens couldn’t load the saved scan. Try again.')
  expect(alert).not.toHaveTextContent(error.error.message)
  expect(diagnostics).toHaveBeenCalledWith(expect.any(String), error.error)
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()

  const retry = screen.getByRole('button', { name: 'Try again' })
  retry.focus()
  expect(retry).toHaveFocus()
  act(() => {
    retry.click()
    retry.click()
  })
  expect(screen.getByRole('heading', { name: 'Storage Insights' })).toHaveFocus()
  expect(within(scanPanel()).getByRole('status')).toHaveTextContent('Loading saved scan')
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  await act(async () => pending.resolve(metadata(regularScan)))
  expect(screen.getByText(regularScan.rootPath)).toBeVisible()
  expect(api.getInsightsSummary).toHaveBeenCalledExactlyOnceWith({ scanId: regularScan.scanId })
})

test('shows a distinct unavailable state for a disappeared summary reference', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  api.getInsightsSummary.mockResolvedValueOnce({
    ok: false,
    error: { code: 'SNAPSHOT_UNAVAILABLE', message: 'Not published' }
  })
  openInsights()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This saved scan is no longer available'
  )
  expect(screen.getByRole('button', { name: 'Reload scan' })).toBeVisible()
  expect(screen.queryByText('No completed scan')).not.toBeInTheDocument()
})

test('re-resolves an expired snapshot when SQLite publishes before its notification', async () => {
  publication = regularScan
  api.getInsightsSummary.mockImplementationOnce(async () => {
    publication = replacement
    return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Already replaced' } }
  })
  openInsights()
  expect(await screen.findByText(replacement.rootPath)).toBeVisible()
  emit(update(1, 'completed'))
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(api.getInsightsSummary.mock.calls).toEqual([
    [{ scanId: regularScan.scanId }],
    [{ scanId: replacement.scanId }]
  ])
  expect(scanPanel().querySelector('time')).toHaveAttribute('datetime', replacement.completedAt)
})

test('stops automatic recovery for the same expired reference and offers reload', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  api.getInsightsSummary.mockResolvedValueOnce({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture' }
  })
  openInsights()
  expect(await screen.findByRole('alert')).toHaveTextContent('The saved scan was replaced')
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(api.getInsightsSummary).toHaveBeenCalledOnce()
  publication = replacement
  fireEvent.click(screen.getByRole('button', { name: 'Reload scan' }))
  expect(await screen.findByText(replacement.rootPath)).toBeVisible()
})

test('keeps the published scan through progress, cancellation and failure, then refreshes on publication', async () => {
  publication = regularScan
  openInsights()
  const oldLegendItem = (await findCategory('Images')).closest('li')!
  act(() => oldLegendItem.focus())
  expect(oldLegendItem).toHaveFocus()
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsSummary>>()
  api.getInsightsSummary.mockReturnValueOnce(pending.promise)
  emit(update(1, 'running'))
  emit(update(2, 'cancelled'))
  emit(update(3, 'running'))
  emit(update(4, 'failed'))
  expect(screen.getByText(regularScan.rootPath)).toBeVisible()
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(api.getInsightsSummary).toHaveBeenCalledOnce()
  expect(api.getInsightsCategories).toHaveBeenCalledOnce()
  expect(oldLegendItem).toHaveFocus()

  publication = replacement
  await act(async () => emit(update(5, 'completed')))
  expect(screen.queryByText(regularScan.rootPath)).not.toBeInTheDocument()
  expect(within(scanPanel()).getByRole('status')).toHaveTextContent('Loading the latest scan')
  expect(scanPanel().querySelector('time')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Storage Insights' })).toHaveFocus()
  expect(screen.queryByRole('region', { name: 'File categories' })).not.toBeInTheDocument()
  emit(update(6, 'completed'))
  await act(async () => pending.resolve(success(replacement)))
  expect(await findCategory('Documents')).toBeVisible()
  expect(screen.getByText(replacement.rootPath)).toBeVisible()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(api.getInsightsSummary).toHaveBeenNthCalledWith(2, { scanId: replacement.scanId })
  expect(api.getInsightsCategories).toHaveBeenNthCalledWith(2, { scanId: replacement.scanId })
})

test('never requests a summary for older metadata received after a publication notification', async () => {
  const pending = Promise.withResolvers<ScannerIpcResult<ScanSnapshotAvailability>>()
  api.getScanSnapshot.mockReturnValueOnce(pending.promise)
  openInsights()
  await act(async () => {})
  publication = replacement
  emit(update(2, 'completed'))
  await act(async () => pending.resolve(metadata(regularScan)))
  expect(screen.getByText(replacement.rootPath)).toBeVisible()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(api.getInsightsSummary).toHaveBeenCalledExactlyOnceWith({ scanId: replacement.scanId })
})

test('ignores a superseded summary, out-of-order revisions, and cross-scan reply identities', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsSummary>>()
  api.getInsightsSummary.mockReturnValueOnce(pending.promise)
  openInsights()
  await act(async () => {})
  const previousUpdate = update(2)
  publication = replacement
  emit(update(3, 'completed'))
  await screen.findByText(replacement.rootPath)
  emit(previousUpdate)
  await act(async () => pending.resolve(success(regularScan)))
  expect(screen.getByText(replacement.rootPath)).toBeVisible()
  expect(screen.queryByText(regularScan.rootPath)).not.toBeInTheDocument()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)

  publication = { ...regularScan, scanId: 'scan-c' }
  api.getInsightsSummary.mockResolvedValueOnce(success(replacement))
  emit(update(4, 'completed'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load the scan summary'
  )
  expect(screen.queryByText(replacement.rootPath)).not.toBeInTheDocument()
})

test.each(['snapshot', 'summary'] as const)(
  'stops handling a pending %s read after unmount',
  async (stage) => {
    publication = regularScan
    const snapshot = Promise.withResolvers<ScannerIpcResult<ScanSnapshotAvailability>>()
    const summary = Promise.withResolvers<ScannerIpcResult<InsightsSummary>>()
    if (stage === 'snapshot') api.getScanSnapshot.mockReturnValueOnce(snapshot.promise)
    else api.getInsightsSummary.mockReturnValueOnce(summary.promise)
    const page = openInsights()
    await act(async () => {})
    expect(listeners.size).toBe(1)
    expect(api.getScanSnapshot).toHaveBeenCalledOnce()
    page.unmount()
    expect(listeners.size).toBe(0)
    const diagnostics = vi.spyOn(console, 'warn')
    await act(async () => {
      snapshot.resolve(metadata(regularScan))
      summary.resolve({ ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Ignore' } })
    })
    expect(diagnostics).not.toHaveBeenCalled()
    expect(api.getScanSnapshot).toHaveBeenCalledOnce()
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(stage === 'snapshot' ? 0 : 1)
  }
)

test('renders the four persisted summary metrics in the responsive grid while categories load', async () => {
  publication = {
    ...regularScan,
    incomplete: true,
    summary: { fileCount: 10_329, directoryCount: 1_234, totalBytes: 1_450_000_000, errorCount: 16 }
  }
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsCategories>>()
  api.getInsightsCategories.mockReturnValueOnce(pending.promise)
  openInsights()
  const summary = await screen.findByRole('region', { name: 'Scan summary' })
  expect(
    within(summary)
      .getAllByRole('term')
      .map((metric) => metric.textContent)
  ).toEqual(['Known Logical Size', 'Files', 'Directories', 'Scan Errors'])
  expect(
    within(summary)
      .getAllByRole('definition')
      .map((metric) => metric.textContent)
  ).toEqual(['1.45 GB', '10,329', '1,234', '16'])
  expect(summary).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'xl:grid-cols-4')
  const loadingCategories = within(categoryPanel()).getByRole('status')
  expect(loadingCategories).toHaveTextContent('Loading file categories')
  expect(loadingCategories).toHaveAttribute('aria-live', 'off')
  expect(screen.getByText('Some items couldn’t be scanned.')).toBeVisible()
  expect(api.getInsightsCategories).toHaveBeenCalledExactlyOnceWith({ scanId: regularScan.scanId })
  await act(async () => pending.resolve(success(categoriesFor(publication!))))
  expect(summary).toBeVisible()
  expect(within(categoryPanel()).getByText('Images')).toBeVisible()
})

const categoryFixture: InsightsCategories = {
  scanId: regularScan.scanId,
  incomplete: true,
  totals: { fileCount: 10, knownBytes: 4_000_000, unknownSizeCount: 1 },
  categories: [
    { category: 'images', fileCount: 8, knownBytes: 1_000_000, unknownSizeCount: 0 },
    { category: 'documents', fileCount: 1, knownBytes: 3_000_000, unknownSizeCount: 0 },
    { category: 'code', fileCount: 1, knownBytes: 0, unknownSizeCount: 1 }
  ]
}

test('shows byte shares, an accessible legend, and tooltips on slice hover and legend focus', async () => {
  publication = {
    ...regularScan,
    incomplete: true,
    summary: { ...regularScan.summary, fileCount: 10, totalBytes: 4_000_000, errorCount: 1 }
  }
  api.getInsightsCategories.mockResolvedValueOnce(success(categoryFixture))
  openInsights()
  const figure = await screen.findByRole('figure', { name: 'Known logical bytes by file category' })
  const legend = within(figure).getByRole('list', { name: 'Category values' })
  const docs = within(legend).getByText('Documents').closest('li')!
  expect(docs).toHaveTextContent('1 file')
  expect(docs).toHaveTextContent('3 MB')
  expect(docs).toHaveTextContent('75%')
  const images = within(legend).getByText('Images').closest('li')!
  expect(images).toHaveTextContent('8 files')
  expect(images).toHaveTextContent('1 MB')
  expect(images).toHaveTextContent('25%')
  const code = within(legend).getByText('Code').closest('li')!
  expect(code).toHaveTextContent('1 file · 1 size unknown')
  expect(code).toHaveTextContent('0 B')
  expect(code).toHaveTextContent('0%')
  expect(figure.querySelectorAll('[data-category]')).toHaveLength(2)
  const docsSlice = figure.querySelector('[data-category="documents"]')!
  expect(docsSlice).toHaveAttribute('stroke-dasharray', '0.75 0.25')
  expect(docsSlice).toHaveAttribute('stroke-dashoffset', '-0.25')
  fireEvent.pointerEnter(docsSlice)
  expect(within(figure).getByRole('tooltip')).toHaveTextContent('Documents3 MB75%')
  fireEvent.pointerLeave(docsSlice)
  expect(within(figure).queryByRole('tooltip')).toBeNull()

  const title = screen.getByRole('heading', { name: 'Storage Insights' })
  act(() => title.focus())
  fireEvent.pointerEnter(docsSlice)
  expect(within(figure).getByRole('tooltip')).toBeVisible()
  fireEvent.keyDown(title, { key: 'Escape' })
  expect(within(figure).queryByRole('tooltip')).toBeNull()
  expect(title).toHaveFocus()

  act(() => docs.focus())
  expect(docs).toHaveFocus()
  expect(docs).toHaveAccessibleDescription('Documents 3 MB 75%')
  fireEvent.keyDown(docs, { key: 'Escape' })
  expect(within(figure).queryByRole('tooltip')).toBeNull()
  expect(docs).toHaveFocus()
})

test('keeps category labels and slice colors stable as values and order change', () => {
  const { container, rerender } = render(<CategoryDonut data={categoryFixture} />)
  const stroke = (category: string): string | null | undefined =>
    container.querySelector(`[data-category="${category}"]`)?.getAttribute('stroke')
  const images = stroke('images')
  const documents = stroke('documents')
  expect(images).toBeTruthy()
  expect(documents).not.toBe(images)
  const changed = categoryFixture.categories
    .map((row) => ({
      ...row,
      knownBytes: row.category === 'images' ? 1 : row.knownBytes
    }))
    .reverse()
  rerender(
    <CategoryDonut
      data={{
        ...categoryFixture,
        totals: { ...categoryFixture.totals, knownBytes: 3_000_001 },
        categories: changed
      }}
    />
  )
  expect(stroke('images')).toBe(images)
  expect(stroke('documents')).toBe(documents)
  expect(screen.getByText('Images').closest('li')).toHaveTextContent('<0.1%')
  expect(screen.getByText('Documents').closest('li')).toHaveTextContent('>99.9%')
})

test.each([0, 2])(
  'retains zero-byte or unknown-size file counts with %i unknown sizes',
  async (unknownSizeCount) => {
    publication = {
      ...regularScan,
      incomplete: unknownSizeCount > 0,
      summary: { ...regularScan.summary, fileCount: 2, totalBytes: 0, errorCount: unknownSizeCount }
    }
    const totals = { fileCount: 2, knownBytes: 0, unknownSizeCount }
    api.getInsightsCategories.mockResolvedValueOnce(
      success({
        ...categoriesFor(publication),
        totals,
        categories: [{ category: 'images', ...totals }]
      })
    )
    openInsights()
    expect(await screen.findByText('No known bytes to chart.')).toBeVisible()
    expect(within(categoryPanel()).getByText('Images').closest('li')).toHaveTextContent('2 files')
    expect(categoryPanel()).not.toHaveTextContent(/NaN|Infinity|%/)
    expect(categoryPanel().querySelector('svg')).toBeNull()
    expect(screen.queryByText('No files were found in this scan.')).toBeNull()
    if (unknownSizeCount) {
      expect(categoryPanel()).toHaveTextContent('2 sizes unknown')
      expect(screen.getByText('Some items couldn’t be scanned.')).toBeVisible()
    }
  }
)

test('keeps summary visible on a category failure and issues one local read on retry', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsCategories>>()
  api.getInsightsCategories
    .mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'Fixture storage error' }
    })
    .mockReturnValueOnce(pending.promise)
  openInsights()
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('SpaceLens couldn’t load file categories. Try again.')
  expect(summaryCards()).toBeVisible()
  expect(api.getInsightsCategories).toHaveBeenCalledOnce()
  const retry = within(categoryPanel()).getByRole('button', { name: 'Retry categories' })
  retry.focus()
  expect(retry).toHaveFocus()
  act(() => {
    retry.click()
    retry.click()
  })
  expect(within(categoryPanel()).getByRole('heading')).toHaveFocus()
  const loadingCategories = within(categoryPanel()).getByRole('status')
  expect(loadingCategories).toBeVisible()
  expect(loadingCategories).toHaveAttribute('aria-live', 'polite')
  expect(summaryCards()).toBeVisible()
  expect(api.getInsightsCategories).toHaveBeenCalledTimes(2)
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(api.getInsightsSummary).toHaveBeenCalledOnce()
  await act(async () => pending.resolve(success(categoriesFor(regularScan))))
  expect(within(categoryPanel()).getByText('Images')).toBeVisible()
})

test('uses confirmed metadata to show categories when the separate summary request fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  api.getInsightsSummary.mockResolvedValueOnce({
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'Fixture summary error' }
  })
  openInsights()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load the scan summary'
  )
  const figure = await screen.findByRole('figure', { name: 'Known logical bytes by file category' })
  expect(within(figure).getByText('Images')).toBeVisible()
  expect(screen.queryByRole('region', { name: 'Scan summary' })).not.toBeInTheDocument()
  fireEvent.click(within(scanPanel()).getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('region', { name: 'Scan summary' })).toBeVisible()
  expect(screen.getByRole('figure', { name: 'Known logical bytes by file category' })).toBe(figure)
  expect(api.getInsightsCategories).toHaveBeenCalledExactlyOnceWith({ scanId: regularScan.scanId })
})

test('clears retained categories as soon as a replacement is announced during a summary retry', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  api.getInsightsSummary.mockResolvedValueOnce({
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'Fixture summary error' }
  })
  openInsights()
  expect(await findCategory('Images')).toBeVisible()
  const pending = Promise.withResolvers<ScannerIpcResult<ScanSnapshotAvailability>>()
  api.getScanSnapshot.mockReturnValueOnce(pending.promise)
  fireEvent.click(within(scanPanel()).getByRole('button', { name: 'Try again' }))
  expect(within(categoryPanel()).getByText('Images')).toBeVisible()

  publication = replacement
  emit(update(1, 'completed'))
  expect(screen.queryByText('Images')).not.toBeInTheDocument()
  expect(within(scanPanel()).getByRole('status')).toHaveTextContent('Loading the latest scan')
  await act(async () => pending.resolve(metadata(regularScan)))
  expect(await findCategory('Documents')).toBeVisible()
  expect(api.getInsightsCategories.mock.calls).toEqual([
    [{ scanId: regularScan.scanId }],
    [{ scanId: replacement.scanId }]
  ])
})

test('discards stale category responses and rejects a mismatched response identity', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsCategories>>()
  api.getInsightsCategories.mockReturnValueOnce(pending.promise)
  openInsights()
  await waitFor(() =>
    expect(api.getInsightsCategories).toHaveBeenCalledExactlyOnceWith({
      scanId: regularScan.scanId
    })
  )
  publication = replacement
  emit(update(1, 'completed'))
  await findCategory('Documents')
  await act(async () => pending.resolve(success(categoriesFor(regularScan))))
  expect(within(categoryPanel()).queryByText('Images')).not.toBeInTheDocument()
  expect(screen.getByText(replacement.rootPath)).toBeVisible()
  publication = { ...regularScan, scanId: 'scan-c' }
  api.getInsightsCategories.mockResolvedValueOnce(success(categoriesFor(replacement)))
  emit(update(2, 'completed'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load file categories'
  )
  expect(within(categoryPanel()).queryByText('Documents')).not.toBeInTheDocument()
  expect(summaryCards()).toBeVisible()
})

test.each([false, true])(
  'rechecks category expiry once when replacement is %s',
  async (replaced) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    publication = regularScan
    api.getInsightsCategories.mockImplementationOnce(async () => {
      if (replaced) publication = replacement
      return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture' } }
    })
    openInsights()
    if (replaced) {
      expect(await findCategory('Documents')).toBeVisible()
      emit(update(1, 'completed'))
      expect(screen.getByText(replacement.rootPath)).toBeVisible()
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('The saved scan may have changed')
      expect(screen.getByText(regularScan.rootPath)).toBeVisible()
      expect(summaryCards()).toBeVisible()
    }
    expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(replaced ? 2 : 1)
    expect(api.getInsightsCategories).toHaveBeenCalledTimes(replaced ? 2 : 1)
  }
)

test('does not recheck an expired category reply that arrives after navigation away', async () => {
  const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsCategories>>()
  publication = regularScan
  api.getInsightsCategories.mockReturnValueOnce(pending.promise)
  const page = openInsights()
  await screen.findByText('Loading file categories…')
  page.unmount()
  await act(async () =>
    pending.resolve({ ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Ignore' } })
  )
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(api.getInsightsCategories).toHaveBeenCalledOnce()
  expect(diagnostic).not.toHaveBeenCalled()
})

test('shows backend extension order, normalized suffixes, known bytes and unknown counts in a semantic table', async () => {
  publication = {
    ...regularScan,
    incomplete: true,
    summary: { fileCount: 1007, directoryCount: 1, totalBytes: 1_250_500, errorCount: 2 }
  }
  const groups = [
    {
      extension: 'jpg',
      category: 'images',
      fileCount: 1004,
      knownBytes: 1_250_000,
      unknownSizeCount: 1
    },
    { extension: 'md', category: 'documents', fileCount: 1, knownBytes: 500, unknownSizeCount: 0 },
    { extension: null, category: 'other', fileCount: 2, knownBytes: 0, unknownSizeCount: 1 }
  ] satisfies InsightsExtensionRow[]
  api.listInsightsExtensions.mockResolvedValueOnce(success(extensionPage(publication, groups)))
  openInsights()
  const table = await screen.findByRole('table', { name: 'File extension groups' })
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent)
  ).toEqual(['Extension', 'Category', 'Files', 'Known logical size', 'Unknown-size files'])
  expect(
    within(table)
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent)
  ).toEqual(['.jpg', '.md', 'No extension'])
  const imageRow = within(table).getByRole('rowheader', { name: '.jpg' }).closest('tr')!
  expect(
    within(imageRow)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
  ).toEqual(['Images', '1,004', '1.25 MB', '1'])
  const noSuffix = within(table).getByRole('rowheader', { name: 'No extension' }).closest('tr')!
  expect(
    within(noSuffix)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
  ).toEqual(['Other', '2', '0 B', '1'])
  const scrollRegion = within(extensionsPanel()).getByRole('region', {
    name: 'Extension groups table'
  })
  expect(scrollRegion).toHaveClass('overflow-x-auto')
  expect(scrollRegion).toHaveAttribute('tabindex', '0')
  expect(within(extensionsPanel()).getByText('1–3 of 3 extensions')).toBeVisible()
})

const extensionGroups = Array.from({ length: 43 }, (_, index): InsightsExtensionRow => ({
  extension: `x${String(index + 1).padStart(3, '0')}`,
  category: 'other',
  fileCount: 1,
  knownBytes: 43 - index,
  unknownSizeCount: 0
}))
const scanWithExtensions: InsightsSummary = {
  ...regularScan,
  summary: { ...regularScan.summary, fileCount: 43, totalBytes: 946 }
}
const previousPage = (): HTMLElement =>
  within(extensionsPanel()).getByRole('button', { name: 'Previous extension page' })
const nextPage = (): HTMLElement =>
  within(extensionsPanel()).getByRole('button', { name: 'Next extension page' })

test('paginates only on demand and preserves keyboard focus while controls are disabled', async () => {
  publication = scanWithExtensions
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsExtensionPage>>()
  api.listInsightsExtensions.mockImplementation(async ({ offset, limit }) =>
    offset === 20
      ? pending.promise
      : success(extensionPage(scanWithExtensions, extensionGroups, offset, limit))
  )
  openInsights()
  expect(await screen.findByText('1–20 of 43 extensions')).toBeVisible()
  expect(within(extensionsPanel()).getAllByRole('rowheader')).toHaveLength(20)
  expect(previousPage()).toHaveAttribute('aria-disabled', 'true')
  expect(nextPage()).toHaveAttribute('aria-disabled', 'false')
  expect(api.listInsightsExtensions).toHaveBeenCalledExactlyOnceWith({
    scanId: regularScan.scanId,
    offset: 0,
    limit: 20
  })
  const next = nextPage()
  next.focus()
  act(() => {
    next.click()
    next.click()
  })
  expect(next).toHaveFocus()
  expect(next).toHaveAttribute('aria-disabled', 'true')
  expect(previousPage()).toHaveAttribute('aria-disabled', 'true')
  const loadingExtensions = within(extensionsPanel()).getByRole('status')
  expect(loadingExtensions).toHaveTextContent('Loading file extensions')
  expect(loadingExtensions).toHaveAttribute('aria-live', 'polite')
  expect(api.listInsightsExtensions).toHaveBeenCalledTimes(2)
  await act(async () =>
    pending.resolve(success(extensionPage(scanWithExtensions, extensionGroups, 20)))
  )
  expect(await screen.findByText('21–40 of 43 extensions')).toBeVisible()
  expect(next).toHaveFocus()
  expect(screen.getByRole('rowheader', { name: '.x021' })).toBeVisible()
  fireEvent.click(next)
  expect(await screen.findByText('41–43 of 43 extensions')).toBeVisible()
  expect(within(extensionsPanel()).getAllByRole('rowheader')).toHaveLength(3)
  expect(next).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(next)
  expect(api.listInsightsExtensions).toHaveBeenCalledTimes(3)
  fireEvent.click(previousPage())
  expect(await screen.findByText('21–40 of 43 extensions')).toBeVisible()
  fireEvent.click(previousPage())
  expect(await screen.findByText('1–20 of 43 extensions')).toBeVisible()
  expect(api.listInsightsExtensions.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 20, 40, 20, 0
  ])
})

test('retries the failed page and leaves the other analytics visible', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = scanWithExtensions
  api.listInsightsExtensions
    .mockResolvedValueOnce(success(extensionPage(scanWithExtensions, extensionGroups)))
    .mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'Extension fixture error' }
    })
    .mockResolvedValueOnce(success(extensionPage(scanWithExtensions, extensionGroups, 20)))
  openInsights()
  await screen.findByText('1–20 of 43 extensions')
  fireEvent.click(nextPage())
  expect(await within(extensionsPanel()).findByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load file extensions'
  )
  expect(summaryCards()).toBeVisible()
  expect(categoryPanel().querySelector('figure')).toBeVisible()
  expect(distributionPanel().querySelector('figure')).toBeVisible()
  const retry = within(extensionsPanel()).getByRole('button', { name: 'Retry extensions' })
  retry.focus()
  act(() => {
    retry.click()
    retry.click()
  })
  expect(within(extensionsPanel()).getByRole('heading')).toHaveFocus()
  expect(await screen.findByText('21–40 of 43 extensions')).toBeVisible()
  expect(api.listInsightsExtensions.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 20, 20
  ])
  expect(api.getInsightsSizeDistribution).toHaveBeenCalledOnce()
  expect(api.getInsightsCategories).toHaveBeenCalledOnce()
})

test('plots file counts in the authoritative bucket order and exposes exact ranges and known byte totals', async () => {
  const sizes = [0, 0, 0, 0, 1, 1_048_575, 1_048_576, 10_485_760, 104_857_600, 1_073_741_824]
  publication = {
    ...regularScan,
    incomplete: true,
    summary: {
      fileCount: sizes.length + 1,
      directoryCount: 1,
      totalBytes: sizes.reduce((sum, size) => sum + size, 0),
      errorCount: 1
    }
  }
  api.getInsightsSizeDistribution.mockResolvedValueOnce(
    success(distributionFor(publication, ...sizes, null))
  )
  openInsights()
  const chart = await screen.findByRole('figure', { name: 'File counts by logical size bucket' })
  const bars = Array.from(chart.querySelectorAll<HTMLElement>('[data-size-bucket]'))
  expect(bars.map((bar) => bar.dataset.sizeBucket)).toEqual([
    'empty',
    'tiny',
    'small',
    'medium',
    'large',
    'veryLarge'
  ])
  expect(bars.map((bar) => bar.style.height)).toEqual(['100%', '50%', '25%', '25%', '25%', '25%'])
  const rows = within(
    within(chart).getByRole('list', { name: 'Size bucket details' })
  ).getAllByRole('listitem')
  const labels = ['Empty', 'Tiny', 'Small', 'Medium', 'Large', 'Very Large']
  const ranges = [
    'Exactly 0 B',
    '1 B to less than 1 MiB',
    '1 MiB to less than 10 MiB',
    '10 MiB to less than 100 MiB',
    '100 MiB to less than 1 GiB',
    '1 GiB and above'
  ]
  rows.forEach((row, index) => {
    expect(within(row).getByText(labels[index])).toBeVisible()
    expect(within(row).getByText(ranges[index])).toBeVisible()
  })
  expect(within(rows[0]).getByText('4 files')).toBeVisible()
  expect(within(rows[0]).getByText('0 B known')).toBeVisible()
  expect(within(rows[1]).getByText('1.05 MB known')).toBeVisible()
  expect(within(rows[5]).getByText('1.07 GB known')).toBeVisible()
  expect(
    within(distributionPanel())
      .getAllByRole('definition')
      .map((value) => value.textContent)
  ).toEqual(['10', '1'])
  expect(screen.getByText('Some items couldn’t be scanned.')).toBeVisible()
})

test.each([
  {
    values: [] as (number | null)[],
    message: 'No files to chart in this scan.',
    known: '0',
    unknown: '0'
  },
  {
    values: [null, null],
    message: 'No file sizes are known for this scan.',
    known: '0',
    unknown: '2'
  }
])(
  'explains the absence of a histogram with $unknown unknown sizes',
  async ({ values, message, known, unknown }) => {
    publication = {
      ...regularScan,
      summary: {
        fileCount: values.length,
        directoryCount: 1,
        totalBytes: 0,
        errorCount: values.length
      },
      incomplete: values.length > 0
    }
    api.getInsightsSizeDistribution.mockResolvedValueOnce(
      success(distributionFor(publication, ...values))
    )
    openInsights()
    expect(await screen.findByText(message)).toBeVisible()
    expect(within(distributionPanel()).queryByRole('figure')).not.toBeInTheDocument()
    expect(
      within(distributionPanel())
        .getAllByRole('definition')
        .map((value) => value.textContent)
    ).toEqual([known, unknown])
    expect(summaryCards()).toBeVisible()
    if (!values.length) {
      expect(await screen.findByText('No extension groups in this scan.')).toBeVisible()
      expect(within(extensionsPanel()).getByText('0 extensions')).toBeVisible()
      expect(previousPage()).toHaveAttribute('aria-disabled', 'true')
      expect(nextPage()).toHaveAttribute('aria-disabled', 'true')
    }
  }
)

test('charts zero-byte files as measured and scales large file counts without losing zero buckets', async () => {
  publication = {
    ...regularScan,
    summary: { fileCount: 9_000_000_000, directoryCount: 1, totalBytes: 0, errorCount: 0 }
  }
  const measured = distributionFor(publication, 0)
  api.getInsightsSizeDistribution.mockResolvedValueOnce(
    success({
      ...measured,
      knownSizeCount: publication.summary.fileCount,
      totals: { ...measured.totals, fileCount: publication.summary.fileCount },
      buckets: measured.buckets.map((bucket) => ({
        ...bucket,
        fileCount: bucket.id === 'empty' ? publication!.summary.fileCount : 0
      }))
    })
  )
  openInsights()
  const chart = await screen.findByRole('figure', { name: 'File counts by logical size bucket' })
  expect(chart.querySelector('[data-size-bucket="empty"]')).toHaveStyle({ height: '100%' })
  expect(chart.querySelector('[data-size-bucket="tiny"]')).toHaveStyle({ height: '0%' })
  expect(within(chart).getByText('9,000,000,000 files')).toBeVisible()
  expect(within(chart).getAllByText('0 B known')).toHaveLength(6)
  expect(chart).not.toHaveTextContent(/NaN|Infinity/)
})

test('loads both new sections independently and retries a rejected distribution without rereading extensions', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsSizeDistribution>>()
  api.getInsightsSizeDistribution.mockReturnValueOnce(pending.promise)
  openInsights()
  expect(await screen.findByRole('table', { name: 'File extension groups' })).toBeVisible()
  expect(within(distributionPanel()).getByRole('status')).toHaveTextContent(
    'Loading file size distribution'
  )
  expect(await findCategory('Images')).toBeVisible()
  expect(summaryCards()).toBeVisible()
  await act(async () => pending.reject(new Error('Fixture request rejected')))
  expect(within(distributionPanel()).getByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load file size distribution'
  )
  fireEvent.click(within(distributionPanel()).getByRole('button', { name: 'Retry distribution' }))
  expect(within(distributionPanel()).getByRole('heading')).toHaveFocus()
  expect(await within(distributionPanel()).findByRole('figure')).toBeVisible()
  expect(api.getInsightsSizeDistribution).toHaveBeenCalledTimes(2)
  expect(api.listInsightsExtensions).toHaveBeenCalledOnce()
})

test('keeps the selected page and distribution during failed or cancelled scans and resets after publication', async () => {
  publication = scanWithExtensions
  api.listInsightsExtensions
    .mockResolvedValueOnce(success(extensionPage(scanWithExtensions, extensionGroups)))
    .mockResolvedValueOnce(success(extensionPage(scanWithExtensions, extensionGroups, 20)))
  openInsights()
  await screen.findByText('1–20 of 43 extensions')
  fireEvent.click(nextPage())
  await screen.findByText('21–40 of 43 extensions')
  const chart = await within(distributionPanel()).findByRole('figure')
  emit(update(1, 'running'))
  emit(update(2, 'cancelled'))
  emit(update(3, 'running'))
  emit(update(4, 'failed'))
  expect(screen.getByText('21–40 of 43 extensions')).toBeVisible()
  expect(within(distributionPanel()).getByRole('figure')).toBe(chart)
  expect(api.getInsightsSizeDistribution).toHaveBeenCalledOnce()
  expect(api.listInsightsExtensions).toHaveBeenCalledTimes(2)
  publication = replacement
  emit(update(5, 'completed'))
  expect(await screen.findByRole('rowheader', { name: '.md' })).toBeVisible()
  expect(api.listInsightsExtensions).toHaveBeenLastCalledWith({
    scanId: replacement.scanId,
    offset: 0,
    limit: 20
  })
  expect(api.getInsightsSizeDistribution).toHaveBeenLastCalledWith({ scanId: replacement.scanId })
  expect(within(distributionPanel()).getByRole('figure')).not.toBe(chart)
})

test('ignores delayed extension pages and distribution responses from a superseded publication', async () => {
  publication = scanWithExtensions
  const extensions = Promise.withResolvers<ScannerIpcResult<InsightsExtensionPage>>()
  const distribution = Promise.withResolvers<ScannerIpcResult<InsightsSizeDistribution>>()
  api.listInsightsExtensions
    .mockResolvedValueOnce(success(extensionPage(scanWithExtensions, extensionGroups)))
    .mockReturnValueOnce(extensions.promise)
  api.getInsightsSizeDistribution.mockReturnValueOnce(distribution.promise)
  openInsights()
  await screen.findByText('1–20 of 43 extensions')
  fireEvent.click(nextPage())
  publication = replacement
  emit(update(1, 'completed'))
  expect(await screen.findByRole('rowheader', { name: '.md' })).toBeVisible()
  const chart = await within(distributionPanel()).findByRole('figure')
  await act(async () => {
    extensions.resolve(success(extensionPage(scanWithExtensions, extensionGroups, 20)))
    distribution.resolve(success(distributionFor(scanWithExtensions, 946, ...Array(42).fill(0))))
  })
  expect(screen.getByRole('rowheader', { name: '.md' })).toBeVisible()
  expect(screen.queryByText('21–40 of 43 extensions')).not.toBeInTheDocument()
  expect(within(distributionPanel()).getByRole('figure')).toBe(chart)
  expect(api.listInsightsExtensions.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 20, 0
  ])
})

test('rechecks the publication when an analytics page expires, then independently loads the new scan', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  api.listInsightsExtensions.mockImplementationOnce(async () => {
    publication = replacement
    return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture' } }
  })
  openInsights()
  expect(await screen.findByRole('rowheader', { name: '.md' })).toBeVisible()
  expect(await findCategory('Documents')).toBeVisible()
  expect(await within(distributionPanel()).findByRole('figure')).toBeVisible()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  expect(api.listInsightsExtensions.mock.calls.map(([request]) => request.scanId)).toEqual([
    regularScan.scanId,
    replacement.scanId
  ])
})

test('ignores expired in-flight extension and distribution replies after unmount', async () => {
  const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = regularScan
  const extensions = Promise.withResolvers<ScannerIpcResult<InsightsExtensionPage>>()
  const distribution = Promise.withResolvers<ScannerIpcResult<InsightsSizeDistribution>>()
  api.listInsightsExtensions.mockReturnValueOnce(extensions.promise)
  api.getInsightsSizeDistribution.mockReturnValueOnce(distribution.promise)
  const page = openInsights()
  await waitFor(() => {
    expect(api.listInsightsExtensions).toHaveBeenCalledOnce()
    expect(api.getInsightsSizeDistribution).toHaveBeenCalledOnce()
  })
  page.unmount()
  await act(async () => {
    const expired = { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Ignore' } } as const
    extensions.resolve(expired)
    distribution.resolve(expired)
  })
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(diagnostics).not.toHaveBeenCalled()
})

const observationsPanel = (): ReturnType<typeof within> =>
  within(screen.getByRole('region', { name: 'Storage observations' }))
const filesRanking = (): ReturnType<typeof within> =>
  within(screen.getByRole('region', { name: 'Largest files' }))
const directoriesRanking = (): ReturnType<typeof within> =>
  within(screen.getByRole('region', { name: 'Largest directories' }))
const scanWithRankings: InsightsSummary = {
  ...regularScan,
  summary: { fileCount: 27, directoryCount: 14, totalBytes: 12_500_000, errorCount: 0 }
}

test('renders global rankings in backend order with original names, full paths and measured sizes', async () => {
  const scan: InsightsSummary = {
    ...regularScan,
    incomplete: true,
    summary: { fileCount: 3, directoryCount: 5, totalBytes: 1_250_000, errorCount: 2 }
  }
  publication = scan
  const name = 'Звіт 📁.bin'
  const firstPath = `${scan.rootPath}\\North\\Archive\\${name}`
  const secondPath = `${scan.rootPath}\\South\\${name}`
  const files = rankedEntries(scan, 'file')
  files[0] = { ...files[0], name, path: firstPath, parentId: 'north-archive' }
  files[1] = { ...files[1], name, path: secondPath, parentId: 'south' }
  files[2] = { ...files[2], bytes: null }
  const directories = rankedEntries(scan, 'directory')
  directories[1] = {
    ...directories[1],
    bytes: scan.summary.totalBytes,
    path: `${directories[0].path}\\${directories[1].name}`,
    parentId: directories[0].id
  }
  directories[3] = { ...directories[3], bytes: null }
  api.listInsightsLargestFiles.mockResolvedValueOnce(success(rankingPage(scan, files)))
  api.listInsightsLargestDirectories.mockResolvedValueOnce(success(rankingPage(scan, directories)))
  openInsights()
  const ordered = await screen.findByRole('list', { name: 'Largest files results' })
  expect(ordered.tagName).toBe('OL')
  expect(ordered).toHaveAttribute('start', '1')
  const rows = within(ordered).getAllByRole('listitem')
  expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual(['#1', '#2', '#3'])
  expect(within(rows[0]).getByText(name)).toBeVisible()
  expect(within(rows[1]).getByText(name)).toBeVisible()
  expect(within(rows[0]).getByText('1.25 MB')).toBeVisible()
  expect(within(rows[1]).getByText('0 B')).toBeVisible()
  expect(within(rows[2]).getByText('Unknown size')).toBeVisible()
  const secondPreview = within(rows[1]).getByTitle(secondPath)
  expect(secondPreview).toHaveClass('truncate')
  expect(secondPreview).toHaveTextContent(`${scan.rootPath}\\South\\`)
  const preview = within(rows[0]).getByTitle(firstPath)
  expect(preview).toHaveAttribute('dir', 'rtl')
  expect(preview).toHaveTextContent(`${scan.rootPath}\\North\\Archive\\`)
  const disclosure = preview.closest('summary')!
  expect(disclosure).toHaveAccessibleName(`Full path: ${firstPath}`)
  disclosure.focus()
  expect(disclosure).toHaveFocus()
  fireEvent.click(disclosure)
  expect(disclosure.parentElement).toHaveAttribute('open')
  expect(within(rows[0]).getByText(firstPath, { selector: 'details p bdi' })).toBeVisible()

  const directoryList = await screen.findByRole('list', { name: 'Largest directories results' })
  expect(within(directoryList).getAllByText('1.25 MB')).toHaveLength(2)
  expect(within(directoryList).getByText('0 B')).toBeVisible()
  expect(within(directoryList).getByText('Unknown size')).toBeVisible()
  expect(directoriesRanking().getByText(/Parent and child totals can overlap/)).toBeVisible()
  expect(screen.getByText('Some items couldn’t be scanned.')).toBeVisible()
  expect(api.listInsightsLargestFiles).toHaveBeenCalledExactlyOnceWith({
    scanId: scan.scanId,
    offset: 0,
    limit: 10
  })
  expect(api.listInsightsLargestDirectories).toHaveBeenCalledExactlyOnceWith({
    scanId: scan.scanId,
    offset: 0,
    limit: 10
  })
  expect(screen.getByRole('region', { name: 'Largest files' }).parentElement).toHaveClass(
    'xl:grid-cols-2',
    'min-w-0'
  )
})

test.each([0, 1, 10])(
  'handles %i eligible files and a scan with no non-root directories',
  async (fileCount) => {
    publication = {
      ...regularScan,
      summary: { fileCount, directoryCount: 1, totalBytes: 0, errorCount: 0 }
    }
    openInsights()
    if (fileCount) {
      expect(await screen.findByText(`1–${fileCount} of ${fileCount} ranked files`)).toBeVisible()
      expect(filesRanking().getAllByRole('listitem')).toHaveLength(fileCount)
    } else {
      expect(await screen.findByText('No files to rank in this scan.')).toBeVisible()
    }
    expect(await screen.findByText('No non-root directories to rank in this scan.')).toBeVisible()
    expect(directoriesRanking().queryByRole('list')).not.toBeInTheDocument()
    for (const [section, type] of [
      [filesRanking(), 'file'],
      [directoriesRanking(), 'directory']
    ] as const) {
      expect(
        section.getByRole('button', { name: `Previous ${type} ranking page` })
      ).toHaveAttribute('aria-disabled', 'true')
      expect(section.getByRole('button', { name: `Next ${type} ranking page` })).toHaveAttribute(
        'aria-disabled',
        'true'
      )
    }
  }
)

test('pages the two restored rankings independently and uses the bounded total and global ordinals', async () => {
  publication = scanWithRankings
  openInsights()
  await screen.findByText('1–10 of 20 ranked files')
  await screen.findByText('1–10 of 13 ranked directories')
  emit(update(1))
  expect(api.listInsightsLargestFiles).toHaveBeenCalledOnce()
  expect(api.listInsightsLargestDirectories).toHaveBeenCalledOnce()
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()

  const fileNext = filesRanking().getByRole('button', { name: 'Next file ranking page' })
  fileNext.focus()
  fireEvent.click(fileNext)
  const lastFilePage = await filesRanking().findByRole('list', { name: 'Largest files results' })
  expect(lastFilePage).toHaveAttribute('start', '11')
  expect(within(lastFilePage).getAllByRole('listitem')[0].firstElementChild).toHaveTextContent(
    '#11'
  )
  expect(within(lastFilePage).getAllByRole('listitem')[9].firstElementChild).toHaveTextContent(
    '#20'
  )
  expect(fileNext).toHaveFocus()
  expect(fileNext).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(fileNext)
  expect(api.listInsightsLargestFiles).toHaveBeenCalledTimes(2)
  expect(api.listInsightsLargestDirectories).toHaveBeenCalledOnce()
  expect(directoriesRanking().getByText('1–10 of 13 ranked directories')).toBeVisible()

  fireEvent.click(directoriesRanking().getByRole('button', { name: 'Next directory ranking page' }))
  expect(await screen.findByText('11–13 of 13 ranked directories')).toBeVisible()
  expect(directoriesRanking().getAllByRole('listitem')).toHaveLength(3)
  fireEvent.click(filesRanking().getByRole('button', { name: 'Previous file ranking page' }))
  expect(await screen.findByText('1–10 of 20 ranked files')).toBeVisible()
  expect(directoriesRanking().getByText('11–13 of 13 ranked directories')).toBeVisible()
  expect(api.listInsightsLargestFiles.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 10, 0
  ])
  expect(api.listInsightsLargestDirectories.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 10
  ])
})

test('keeps other analytics visible while a ranking page loads or fails and retries just that page', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = scanWithRankings
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsRankingPage>>()
  api.listInsightsLargestFiles
    .mockImplementationOnce(readRanking('file'))
    .mockReturnValueOnce(pending.promise)
  openInsights()
  await screen.findByText('1–10 of 20 ranked files')
  await screen.findByText('1–10 of 13 ranked directories')
  const next = filesRanking().getByRole('button', { name: 'Next file ranking page' })
  act(() => {
    next.click()
    next.click()
  })
  expect(filesRanking().getByRole('status')).toHaveTextContent('Loading largest files')
  expect(next).toHaveAttribute('aria-disabled', 'true')
  expect(api.listInsightsLargestFiles).toHaveBeenCalledTimes(2)
  await act(async () =>
    pending.resolve({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'File ranking fixture error' }
    })
  )
  expect(filesRanking().getByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load largest files'
  )
  expect(directoriesRanking().getByText('1–10 of 13 ranked directories')).toBeVisible()
  expect(summaryCards()).toBeVisible()
  expect(categoryPanel().querySelector('figure')).toBeVisible()
  expect(distributionPanel().querySelector('figure')).toBeVisible()
  expect(extensionsPanel().querySelector('table')).toBeVisible()

  fireEvent.click(filesRanking().getByRole('button', { name: 'Retry largest files' }))
  expect(filesRanking().getByRole('heading')).toHaveFocus()
  expect(await screen.findByText('11–20 of 20 ranked files')).toBeVisible()
  expect(api.listInsightsLargestFiles.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 10, 10
  ])
  expect(api.listInsightsLargestDirectories).toHaveBeenCalledOnce()
})

test('preserves both pages during a scan, cancellation or failure and resets them on replacement', async () => {
  publication = scanWithRankings
  openInsights()
  await screen.findByText('1–10 of 20 ranked files')
  await screen.findByText('1–10 of 13 ranked directories')
  fireEvent.click(filesRanking().getByRole('button', { name: 'Next file ranking page' }))
  fireEvent.click(directoriesRanking().getByRole('button', { name: 'Next directory ranking page' }))
  await screen.findByText('11–20 of 20 ranked files')
  const oldPage = await screen.findByText('11–13 of 13 ranked directories')
  emit(update(1, 'running'))
  emit(update(2, 'cancelled'))
  emit(update(3, 'running'))
  emit(update(4, 'failed'))
  expect(oldPage).toBeVisible()
  expect(filesRanking().getByText('11–20 of 20 ranked files')).toBeVisible()
  expect(api.listInsightsLargestFiles).toHaveBeenCalledTimes(2)
  expect(api.listInsightsLargestDirectories).toHaveBeenCalledTimes(2)

  publication = { ...scanWithRankings, ...replacement, summary: scanWithRankings.summary }
  emit(update(5, 'completed'))
  expect(await screen.findByText('1–10 of 20 ranked files')).toBeVisible()
  expect(await screen.findByText('1–10 of 13 ranked directories')).toBeVisible()
  expect(api.listInsightsLargestFiles).toHaveBeenLastCalledWith({
    scanId: replacement.scanId,
    offset: 0,
    limit: 10
  })
  expect(api.listInsightsLargestDirectories).toHaveBeenLastCalledWith({
    scanId: replacement.scanId,
    offset: 0,
    limit: 10
  })
})

test('ignores an old page that arrives after replacement ranking results', async () => {
  publication = scanWithRankings
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsRankingPage>>()
  api.listInsightsLargestDirectories
    .mockImplementationOnce(readRanking('directory'))
    .mockReturnValueOnce(pending.promise)
  openInsights()
  await screen.findByText('1–10 of 13 ranked directories')
  fireEvent.click(directoriesRanking().getByRole('button', { name: 'Next directory ranking page' }))
  expect(directoriesRanking().getByRole('status')).toBeVisible()
  publication = { ...replacement, summary: { ...replacement.summary, directoryCount: 2 } }
  emit(update(1, 'completed'))
  expect(await screen.findByText('1–1 of 1 ranked directories')).toBeVisible()
  await act(async () =>
    pending.resolve(
      success(rankingPage(scanWithRankings, rankedEntries(scanWithRankings, 'directory'), 10))
    )
  )
  expect(directoriesRanking().getByText('1–1 of 1 ranked directories')).toBeVisible()
  expect(directoriesRanking().queryByText('directory-11')).not.toBeInTheDocument()
  expect(directoriesRanking().getByTitle(`${replacement.rootPath}\\directory-01`)).toBeVisible()
})

test('rechecks an expired ranking against SQLite and discards a cross-scan payload', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = scanWithRankings
  api.listInsightsLargestDirectories.mockImplementationOnce(async () => {
    publication = replacement
    return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Fixture replaced' } }
  })
  api.listInsightsLargestFiles
    .mockImplementationOnce(readRanking('file'))
    .mockResolvedValueOnce(
      success(rankingPage(scanWithRankings, rankedEntries(scanWithRankings, 'file')))
    )
  openInsights()
  expect(await screen.findByText('No non-root directories to rank in this scan.')).toBeVisible()
  expect(await filesRanking().findByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load largest files'
  )
  expect(filesRanking().queryByRole('list')).not.toBeInTheDocument()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
  fireEvent.click(filesRanking().getByRole('button', { name: 'Retry largest files' }))
  expect(await screen.findByText('1–3 of 3 ranked files')).toBeVisible()
  expect(api.listInsightsLargestFiles).toHaveBeenLastCalledWith({
    scanId: replacement.scanId,
    offset: 0,
    limit: 10
  })
})

test('does not process ranking requests that finish after unmount', async () => {
  const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = scanWithRankings
  const files = Promise.withResolvers<ScannerIpcResult<InsightsRankingPage>>()
  const directories = Promise.withResolvers<ScannerIpcResult<InsightsRankingPage>>()
  api.listInsightsLargestFiles.mockReturnValueOnce(files.promise)
  api.listInsightsLargestDirectories.mockReturnValueOnce(directories.promise)
  const view = openInsights()
  await waitFor(() => {
    expect(api.listInsightsLargestFiles).toHaveBeenCalledOnce()
    expect(api.listInsightsLargestDirectories).toHaveBeenCalledOnce()
  })
  view.unmount()
  await act(async () => {
    const expired = { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Ignore' } } as const
    files.resolve(expired)
    directories.resolve(expired)
  })
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(diagnostics).not.toHaveBeenCalled()
})

const observationFixture: InsightsObservations = {
  scanId: regularScan.scanId,
  incomplete: true,
  observations: [
    {
      id: 'incompleteScan',
      type: 'incompleteScan',
      title: 'Incomplete scan coverage',
      message: 'Some file sizes were unavailable.',
      severity: 'warning',
      evidence: { errorCount: 2, unknownSizeCount: 2 }
    },
    {
      id: 'largeFileConcentration',
      type: 'largeFileConcentration',
      title: 'Known bytes concentrated in a few files',
      message: 'The 5 largest files account for at least 50% of known logical bytes.',
      severity: 'info',
      evidence: { fileCount: 5, knownBytes: 15_000_000, totalKnownBytes: 25_000_000 }
    },
    {
      id: 'dominantCategory',
      type: 'dominantCategory',
      title: 'One file category has a large byte share',
      message: 'The images category accounts for at least 60% of known logical bytes.',
      severity: 'info',
      evidence: { category: 'images', knownBytes: 20_000_000, totalKnownBytes: 25_000_000 }
    },
    {
      id: 'directoryConcentration',
      type: 'directoryConcentration',
      title: 'Known bytes concentrated in one directory',
      message: 'The largest non-root directory contains at least 50% of known logical bytes.',
      severity: 'info',
      evidence: { entryId: 'largest-dir', knownBytes: 18_000_000, totalKnownBytes: 25_000_000 }
    },
    {
      id: 'smallFilesPrevalence',
      type: 'smallFilesPrevalence',
      title: 'Most measured files are small',
      message: 'At least 80% of files with known sizes are empty or smaller than 1 MiB.',
      severity: 'info',
      evidence: { smallFileCount: 18, knownSizeCount: 22 }
    }
  ]
}

test('renders the five supplied observations in order with severity, original copy and measured evidence', async () => {
  publication = {
    ...regularScan,
    incomplete: true,
    summary: { fileCount: 24, directoryCount: 4, totalBytes: 25_000_000, errorCount: 2 }
  }
  api.getInsightsObservations.mockResolvedValueOnce(success(observationFixture))
  openInsights()
  const list = await screen.findByRole('list', { name: 'Scan observations' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows.map((row) => row.dataset.observationId)).toEqual(
    observationFixture.observations.map(({ id }) => id)
  )
  expect(rows.map((row) => row.dataset.observationType)).toEqual(
    observationFixture.observations.map(({ type }) => type)
  )
  const evidence = [
    '2 filesystem errors · 2 files with unknown sizes',
    '15 MB of 25 MB in known logical bytes',
    '20 MB of 25 MB in known logical bytes',
    '18 MB of 25 MB in known logical bytes',
    '18 of 22 files with known sizes'
  ]
  rows.forEach((row, index) => {
    const item = observationFixture.observations[index]
    expect(within(row).getByRole('heading', { name: item.title })).toBeVisible()
    expect(within(row).getByText(item.message)).toBeVisible()
    expect(
      within(row).getByText(item.severity === 'warning' ? 'Warning' : 'Information')
    ).toBeVisible()
    expect(within(row).getByText(evidence[index])).toBeVisible()
  })
  expect(screen.getByText('Some items couldn’t be scanned.')).toBeVisible()
  emit(update(1, 'running'))
  emit(update(2, 'cancelled'))
  expect(observationsPanel().getByRole('list', { name: 'Scan observations' })).toBe(list)
  expect(api.getInsightsObservations).toHaveBeenCalledExactlyOnceWith({
    scanId: regularScan.scanId
  })
})

test('preserves zero evidence on an incomplete zero-byte scan', async () => {
  publication = {
    ...regularScan,
    incomplete: true,
    summary: { ...regularScan.summary, totalBytes: 0, errorCount: 1 }
  }
  const {
    observations: [warning]
  } = observationFixture
  api.getInsightsObservations.mockResolvedValueOnce(
    success({
      ...observationFixture,
      observations: [
        {
          ...warning,
          id: 'incompleteScan',
          type: 'incompleteScan',
          evidence: { errorCount: 1, unknownSizeCount: 0 }
        }
      ]
    })
  )
  openInsights()
  expect(await screen.findByText('1 filesystem error · 0 files with unknown sizes')).toBeVisible()
  expect(observationsPanel().getAllByRole('listitem')).toHaveLength(1)
  expect(summaryCards()).toHaveTextContent('0 B')
})

test('keeps other analytics usable while observations load or fail and retries independently', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  publication = scanWithRankings
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsObservations>>()
  api.getInsightsObservations.mockReturnValueOnce(pending.promise)
  openInsights()
  await screen.findByText('1–10 of 20 ranked files')
  expect(observationsPanel().getByRole('status')).toHaveTextContent('Loading storage observations')
  expect(summaryCards()).toBeVisible()
  expect(await within(categoryPanel()).findByRole('figure')).toBeVisible()
  expect(await within(distributionPanel()).findByRole('figure')).toBeVisible()
  expect(await within(extensionsPanel()).findByRole('table')).toBeVisible()

  await act(async () =>
    pending.resolve({ ok: false, error: { code: 'UNAVAILABLE', message: 'Unavailable fixture' } })
  )
  expect(observationsPanel().getByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load storage observations'
  )
  fireEvent.click(observationsPanel().getByRole('button', { name: 'Retry observations' }))
  expect(observationsPanel().getByRole('heading')).toHaveFocus()
  expect(
    await observationsPanel().findByText('No notable patterns met the observation rules.')
  ).toBeVisible()
  expect(api.getInsightsObservations.mock.calls).toEqual([
    [{ scanId: regularScan.scanId }],
    [{ scanId: regularScan.scanId }]
  ])
  expect(api.listInsightsLargestFiles).toHaveBeenCalledOnce()
  expect(api.getInsightsSummary).toHaveBeenCalledOnce()
  expect(api.listInsightsExtensions).toHaveBeenCalledOnce()
})

test('preserves observations on cancellation and rejects late results after a replacement', async () => {
  publication = regularScan
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsObservations>>()
  api.getInsightsObservations.mockReturnValueOnce(pending.promise)
  openInsights()
  await screen.findByText('Loading storage observations…')
  await waitFor(() => expect(api.getInsightsObservations).toHaveBeenCalledOnce())
  emit(update(1, 'running'))
  emit(update(2, 'cancelled'))
  expect(api.getInsightsObservations).toHaveBeenCalledOnce()
  publication = replacement
  emit(update(3, 'completed'))
  expect(await screen.findByText('No notable patterns met the observation rules.')).toBeVisible()
  await act(async () => pending.resolve(success(observationFixture)))
  expect(observationsPanel().queryByText('Incomplete scan coverage')).not.toBeInTheDocument()
  expect(api.getInsightsObservations.mock.calls).toEqual([
    [{ scanId: regularScan.scanId }],
    [{ scanId: replacement.scanId }]
  ])
})

test('ignores an expired observation response on unmount', async () => {
  publication = regularScan
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsObservations>>()
  api.getInsightsObservations.mockReturnValueOnce(pending.promise)
  const view = openInsights()
  await waitFor(() => expect(api.getInsightsObservations).toHaveBeenCalledOnce())
  view.unmount()
  await act(async () =>
    pending.resolve({ ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Ignore' } })
  )
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
})
