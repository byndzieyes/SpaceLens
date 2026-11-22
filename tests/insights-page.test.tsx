import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi, type Mocked } from 'vitest'
import App from '../src/renderer/src/App'
import { CategoryDonut } from '../src/renderer/src/features/insights/CategoryDonut'
import { InsightsPage } from '../src/renderer/src/pages/InsightsPage'
import {
  INSIGHTS_SIZE_BUCKETS,
  type InsightsCategories,
  type InsightsExtensionPage,
  type InsightsExtensionRow,
  type InsightsFileCategory,
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
  offset = 0
): InsightsExtensionPage {
  const extensions = rows.slice(offset, offset + 50)
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
    getInsightsObservations: vi.fn(),
    listInsightsExtensions: vi.fn(async ({ scanId, offset }) => {
      if (publication?.scanId !== scanId) {
        return { ok: false, error: { code: 'SNAPSHOT_EXPIRED', message: 'Expired fixture ID' } }
      }
      const original = scanId === regularScan.scanId
      const category = original ? 'images' : 'documents'
      const rows = categoriesFor(publication, category).categories.map((row) => ({
        ...row,
        extension: original ? 'jpg' : 'md'
      }))
      return success(extensionPage(publication, rows, offset))
    }),
    listInsightsLargestFiles: vi.fn(),
    listInsightsLargestDirectories: vi.fn(),
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
    limit: 50
  })
  expect(api.getScanState).not.toHaveBeenCalled()
  for (const query of [
    api.getScanEntry,
    api.listScanDirectory,
    api.getScanDirectoryTreemap,
    api.listInsightsLargestFiles,
    api.listInsightsLargestDirectories,
    api.getInsightsObservations
  ]) {
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
  expect(within(categoryPanel()).getByRole('status')).toHaveTextContent('Loading file categories')
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
  expect(within(categoryPanel()).getByRole('status')).toBeVisible()
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
  await screen.findByRole('region', { name: 'Scan summary' })
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

const extensionGroups = Array.from({ length: 103 }, (_, index): InsightsExtensionRow => ({
  extension: `x${String(index + 1).padStart(3, '0')}`,
  category: 'other',
  fileCount: 1,
  knownBytes: 103 - index,
  unknownSizeCount: 0
}))
const scanWithExtensions: InsightsSummary = {
  ...regularScan,
  summary: { ...regularScan.summary, fileCount: 103, totalBytes: 5356 }
}
const previousPage = (): HTMLElement =>
  within(extensionsPanel()).getByRole('button', { name: 'Previous extension page' })
const nextPage = (): HTMLElement =>
  within(extensionsPanel()).getByRole('button', { name: 'Next extension page' })

test('paginates only on demand and preserves keyboard focus while controls are disabled', async () => {
  publication = scanWithExtensions
  const pending = Promise.withResolvers<ScannerIpcResult<InsightsExtensionPage>>()
  api.listInsightsExtensions.mockImplementation(async ({ offset }) =>
    offset === 50
      ? pending.promise
      : success(extensionPage(scanWithExtensions, extensionGroups, offset))
  )
  openInsights()
  expect(await screen.findByText('1–50 of 103 extensions')).toBeVisible()
  expect(previousPage()).toHaveAttribute('aria-disabled', 'true')
  expect(nextPage()).toHaveAttribute('aria-disabled', 'false')
  expect(api.listInsightsExtensions).toHaveBeenCalledExactlyOnceWith({
    scanId: regularScan.scanId,
    offset: 0,
    limit: 50
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
  expect(within(extensionsPanel()).getByRole('status')).toHaveTextContent('Loading file extensions')
  expect(api.listInsightsExtensions).toHaveBeenCalledTimes(2)
  await act(async () =>
    pending.resolve(success(extensionPage(scanWithExtensions, extensionGroups, 50)))
  )
  expect(await screen.findByText('51–100 of 103 extensions')).toBeVisible()
  expect(next).toHaveFocus()
  expect(screen.getByRole('rowheader', { name: '.x051' })).toBeVisible()
  fireEvent.click(next)
  expect(await screen.findByText('101–103 of 103 extensions')).toBeVisible()
  expect(next).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(next)
  expect(api.listInsightsExtensions).toHaveBeenCalledTimes(3)
  fireEvent.click(previousPage())
  expect(await screen.findByText('51–100 of 103 extensions')).toBeVisible()
  fireEvent.click(previousPage())
  expect(await screen.findByText('1–50 of 103 extensions')).toBeVisible()
  expect(api.listInsightsExtensions.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 50, 100, 50, 0
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
    .mockResolvedValueOnce(success(extensionPage(scanWithExtensions, extensionGroups, 50)))
  openInsights()
  await screen.findByText('1–50 of 103 extensions')
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
  expect(await screen.findByText('51–100 of 103 extensions')).toBeVisible()
  expect(api.listInsightsExtensions.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 50, 50
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
    .mockResolvedValueOnce(success(extensionPage(scanWithExtensions, extensionGroups, 50)))
  openInsights()
  await screen.findByText('1–50 of 103 extensions')
  fireEvent.click(nextPage())
  await screen.findByText('51–100 of 103 extensions')
  const chart = await within(distributionPanel()).findByRole('figure')
  emit(update(1, 'running'))
  emit(update(2, 'cancelled'))
  emit(update(3, 'running'))
  emit(update(4, 'failed'))
  expect(screen.getByText('51–100 of 103 extensions')).toBeVisible()
  expect(within(distributionPanel()).getByRole('figure')).toBe(chart)
  expect(api.getInsightsSizeDistribution).toHaveBeenCalledOnce()
  expect(api.listInsightsExtensions).toHaveBeenCalledTimes(2)
  publication = replacement
  emit(update(5, 'completed'))
  expect(await screen.findByRole('rowheader', { name: '.md' })).toBeVisible()
  expect(api.listInsightsExtensions).toHaveBeenLastCalledWith({
    scanId: replacement.scanId,
    offset: 0,
    limit: 50
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
  await screen.findByText('1–50 of 103 extensions')
  fireEvent.click(nextPage())
  publication = replacement
  emit(update(1, 'completed'))
  expect(await screen.findByRole('rowheader', { name: '.md' })).toBeVisible()
  const chart = await within(distributionPanel()).findByRole('figure')
  await act(async () => {
    extensions.resolve(success(extensionPage(scanWithExtensions, extensionGroups, 50)))
    distribution.resolve(success(distributionFor(scanWithExtensions, 5356, ...Array(102).fill(0))))
  })
  expect(screen.getByRole('rowheader', { name: '.md' })).toBeVisible()
  expect(screen.queryByText('51–100 of 103 extensions')).not.toBeInTheDocument()
  expect(within(distributionPanel()).getByRole('figure')).toBe(chart)
  expect(api.listInsightsExtensions.mock.calls.map(([request]) => request.offset)).toEqual([
    0, 50, 0
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
