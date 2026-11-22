import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi, type Mocked } from 'vitest'
import App from '../src/renderer/src/App'
import { CategoryDonut } from '../src/renderer/src/features/insights/CategoryDonut'
import { InsightsPage } from '../src/renderer/src/pages/InsightsPage'
import type {
  InsightsCategories,
  InsightsFileCategory,
  InsightsSummary
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
    getInsightsSizeDistribution: vi.fn(),
    getInsightsObservations: vi.fn(),
    listInsightsExtensions: vi.fn(),
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
  expect(api.getScanState).not.toHaveBeenCalled()
  for (const query of [
    api.getScanEntry,
    api.listScanDirectory,
    api.getScanDirectoryTreemap,
    api.listInsightsExtensions,
    api.listInsightsLargestFiles,
    api.listInsightsLargestDirectories,
    api.getInsightsSizeDistribution,
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
  expect(screen.getByRole('status')).toHaveTextContent('Loading saved scan')
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
  const oldLegendItem = (await screen.findByText('Images')).closest('li')!
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
  expect(screen.getByRole('status')).toHaveTextContent('Loading the latest scan')
  expect(scanPanel().querySelector('time')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Storage Insights' })).toHaveFocus()
  expect(screen.queryByRole('region', { name: 'File categories' })).not.toBeInTheDocument()
  emit(update(6, 'completed'))
  await act(async () => pending.resolve(success(replacement)))
  expect(await screen.findByText('Documents')).toBeVisible()
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
  const figure = await screen.findByRole('figure')
  expect(within(figure).getByText('Images')).toBeVisible()
  expect(screen.queryByRole('region', { name: 'Scan summary' })).not.toBeInTheDocument()
  fireEvent.click(within(scanPanel()).getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('region', { name: 'Scan summary' })).toBeVisible()
  expect(screen.getByRole('figure')).toBe(figure)
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
  expect(await screen.findByText('Images')).toBeVisible()
  const pending = Promise.withResolvers<ScannerIpcResult<ScanSnapshotAvailability>>()
  api.getScanSnapshot.mockReturnValueOnce(pending.promise)
  fireEvent.click(within(scanPanel()).getByRole('button', { name: 'Try again' }))
  expect(screen.getByText('Images')).toBeVisible()

  publication = replacement
  emit(update(1, 'completed'))
  expect(screen.queryByText('Images')).not.toBeInTheDocument()
  expect(within(scanPanel()).getByRole('status')).toHaveTextContent('Loading the latest scan')
  await act(async () => pending.resolve(metadata(regularScan)))
  expect(await screen.findByText('Documents')).toBeVisible()
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
  await screen.findByText('Documents')
  await act(async () => pending.resolve(success(categoriesFor(regularScan))))
  expect(screen.queryByText('Images')).not.toBeInTheDocument()
  expect(screen.getByText(replacement.rootPath)).toBeVisible()
  publication = { ...regularScan, scanId: 'scan-c' }
  api.getInsightsCategories.mockResolvedValueOnce(success(categoriesFor(replacement)))
  emit(update(2, 'completed'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'SpaceLens couldn’t load file categories'
  )
  expect(screen.queryByText('Documents')).not.toBeInTheDocument()
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
      expect(await screen.findByText('Documents')).toBeVisible()
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
