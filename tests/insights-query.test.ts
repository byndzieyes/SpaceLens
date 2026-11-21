// @vitest-environment node
import { beforeEach, expect, expectTypeOf, test, vi } from 'vitest'
import { InsightsQueryService } from '../src/main/insights/queryService'
import {
  StorageUnavailableError,
  type ScanStorageCoordinator
} from '../src/main/storage/coordinator'
import type { CompletedScan } from '../src/main/storage/payloads'
import { SnapshotAccessError } from '../src/main/storage/snapshotAccess'
import type { StorageWorkerClient } from '../src/main/storage/workerClient'
import { parseStorageResponse } from '../src/main/storage/workerProtocol'
import type { InsightsRequest, InsightsSummary } from '../src/shared/insights'
import type { ScannerIpcResult, SpaceLensAPI } from '../src/shared/ipc'

const queries = {
  requirePublishedScan: vi.fn<StorageWorkerClient['requirePublishedScan']>(),
  getInsightsCategories: vi.fn<StorageWorkerClient['getInsightsCategories']>(),
  listInsightsExtensions: vi.fn<StorageWorkerClient['listInsightsExtensions']>(),
  listInsightsLargestFiles: vi.fn<StorageWorkerClient['listInsightsLargestFiles']>(),
  listInsightsLargestDirectories: vi.fn<StorageWorkerClient['listInsightsLargestDirectories']>(),
  getScanSnapshot: vi.fn<StorageWorkerClient['getScanSnapshot']>(),
  getScanEntry: vi.fn<StorageWorkerClient['getScanEntry']>(),
  listScanDirectory: vi.fn<StorageWorkerClient['listScanDirectory']>(),
  getScanDirectoryTreemap: vi.fn<StorageWorkerClient['getScanDirectoryTreemap']>()
}
const read = vi.fn()
const storage: Pick<ScanStorageCoordinator, 'read'> = {
  read: (signal, query) => {
    read(signal)
    return query(queries)
  }
}
const insights = new InsightsQueryService(storage)
const { signal } = new AbortController()
const request = { scanId: 'published_1' } satisfies InsightsRequest
const completed: CompletedScan = {
  id: request.scanId,
  rootPath: 'C:\\fixtures\\Storage',
  startedAt: '2026-11-20T13:00:00.000+02:00',
  finishedAt: '2026-11-20T13:03:00.000+02:00',
  status: 'completed',
  summary: { totalBytes: Number.MAX_SAFE_INTEGER, fileCount: 42, directoryCount: 5, errorCount: 2 }
}

beforeEach(() => {
  read.mockClear()
  queries.requirePublishedScan.mockReset()
  queries.getInsightsCategories.mockReset()
  queries.listInsightsExtensions.mockReset()
  queries.listInsightsLargestFiles.mockReset()
  queries.listInsightsLargestDirectories.mockReset()
})

test('the public Insights method uses the shared request and structured result', () => {
  expectTypeOf<SpaceLensAPI['getInsightsSummary']>().toEqualTypeOf<
    (request: InsightsRequest) => Promise<ScannerIpcResult<InsightsSummary>>
  >()
})

test.each([
  { summary: completed.summary, incomplete: true },
  { summary: { totalBytes: 0, fileCount: 0, directoryCount: 1, errorCount: 0 }, incomplete: false }
])(
  'projects only the requested publication using its stored totals',
  async ({ summary, incomplete }) => {
    queries.requirePublishedScan.mockResolvedValueOnce({ ...completed, summary })
    const result = await insights.getSummary(request, signal)

    expect(read).toHaveBeenCalledExactlyOnceWith(signal)
    expect(queries.requirePublishedScan).toHaveBeenCalledExactlyOnceWith(request.scanId)
    expect(queries.getScanSnapshot).not.toHaveBeenCalled()
    expect(queries.getScanEntry).not.toHaveBeenCalled()
    expect(queries.listScanDirectory).not.toHaveBeenCalled()
    expect(queries.getScanDirectoryTreemap).not.toHaveBeenCalled()
    expect(result.summary).toBe(summary)
    expect(structuredClone(result)).toEqual({
      scanId: completed.id,
      rootPath: completed.rootPath,
      completedAt: completed.finishedAt,
      summary,
      incomplete
    })
  }
)

test('rejects invalid request shapes before scheduling a read', async () => {
  for (const invalid of [
    undefined,
    null,
    request.scanId,
    [request],
    {},
    { scanId: 42 },
    { scanId: '' },
    { scanId: 'x'.repeat(129) },
    { scanId: 'old/scan' },
    { ...request, sql: 'SELECT 1' },
    Object.assign(Object.create(request), { rootPath: 'somewhere' })
  ]) {
    await expect(insights.getSummary(invalid, signal)).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
  }
  expect(read).not.toHaveBeenCalled()
})

test.each([
  new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'No published scan'),
  new SnapshotAccessError('SNAPSHOT_EXPIRED', 'Old publication'),
  new StorageUnavailableError()
])('propagates %s without retrying', async (error) => {
  queries.requirePublishedScan.mockRejectedValueOnce(error)
  await expect(insights.getSummary(request, signal)).rejects.toBe(error)
  expect(read).toHaveBeenCalledOnce()
})

test('rejects a scoped storage reply containing a different scan ID', async () => {
  queries.requirePublishedScan.mockResolvedValueOnce({ ...completed, id: 'replacement' })
  await expect(insights.getSummary(request, signal)).rejects.toThrow('different publication')
})

test('scoped Worker replies require a completed scan and exact numeric metadata', () => {
  const reply = { requestId: 1, ok: true, result: completed }
  expect(parseStorageResponse(reply, 1, 'requirePublishedScan')).toEqual(reply)
  for (const result of [
    null,
    { ...completed, status: 'running', finishedAt: null },
    { ...completed, finishedAt: null },
    { ...completed, summary: { ...completed.summary, totalBytes: Number.MAX_SAFE_INTEGER + 1 } },
    { ...completed, summary: { ...completed.summary, fileCount: null } }
  ]) {
    expect(() => parseStorageResponse({ ...reply, result }, 1, 'requirePublishedScan')).toThrow(
      'Invalid response'
    )
  }
})

test('dispatches categories and normalizes extension page defaults within the shared read lane', async () => {
  const result = {
    scanId: request.scanId,
    incomplete: false,
    totals: { fileCount: 0, knownBytes: 0, unknownSizeCount: 0 }
  }
  const categories = { ...result, categories: [] }
  const extensions = { ...result, extensions: [], totalCount: 0, nextOffset: null }
  queries.getInsightsCategories.mockResolvedValueOnce(categories)
  queries.listInsightsExtensions.mockResolvedValueOnce(extensions)
  queries.listInsightsExtensions.mockResolvedValueOnce(extensions)
  await expect(insights.getCategories(request, signal)).resolves.toBe(categories)
  await expect(insights.listExtensions(request, signal)).resolves.toBe(extensions)
  await expect(insights.listExtensions({ ...request, limit: 100 }, signal)).resolves.toBe(
    extensions
  )
  expect(queries.getInsightsCategories).toHaveBeenCalledExactlyOnceWith(request.scanId)
  expect(queries.listInsightsExtensions).toHaveBeenNthCalledWith(1, {
    ...request,
    offset: 0,
    limit: 50
  })
  expect(queries.listInsightsExtensions).toHaveBeenNthCalledWith(2, {
    ...request,
    offset: 0,
    limit: 100
  })
  expect(read.mock.calls).toEqual([[signal], [signal], [signal]])
})

test('rejects invalid pagination before enqueuing and refuses a different publication', async () => {
  for (const invalid of [
    { ...request, offset: -1 },
    { ...request, offset: 1.5 },
    { ...request, offset: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, limit: 0 },
    { ...request, limit: 101 },
    { ...request, limit: undefined },
    { ...request, limit: '10' },
    { ...request, offset: Infinity },
    { ...request, entryId: 'directory' }
  ]) {
    await expect(insights.listExtensions(invalid, signal)).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
  }
  expect(read).not.toHaveBeenCalled()
  queries.getInsightsCategories.mockResolvedValueOnce({
    scanId: 'replacement',
    incomplete: false,
    totals: { fileCount: 0, knownBytes: 0, unknownSizeCount: 0 },
    categories: []
  })
  await expect(insights.getCategories(request, signal)).rejects.toThrow('different publication')
})

test('Worker replies reject unsafe counts and oversized extension pages', () => {
  const totals = { fileCount: 1, knownBytes: Number.MAX_SAFE_INTEGER, unknownSizeCount: 0 }
  const group = { ...totals, extension: null, category: 'other' }
  const page = {
    scanId: request.scanId,
    incomplete: false,
    totals,
    extensions: [group],
    totalCount: 1,
    nextOffset: null
  }
  const reply = { requestId: 1, ok: true, result: page }
  expect(parseStorageResponse(reply, 1, 'listInsightsExtensions')).toEqual(reply)
  for (const result of [
    { ...page, totals: { ...totals, knownBytes: Number.MAX_SAFE_INTEGER + 1 } },
    { ...page, extensions: [{ ...group, unknownSizeCount: 2 }] },
    {
      ...page,
      totals: { ...totals, fileCount: 101 },
      totalCount: 101,
      extensions: Array(101).fill(group)
    },
    { ...page, extensions: [{ ...group, category: 'unsupported' }] }
  ]) {
    expect(() => parseStorageResponse({ ...reply, result }, 1, 'listInsightsExtensions')).toThrow(
      'Invalid response'
    )
  }
})

test('normalizes ranking requests and rejects a reply for a different page or publication', async () => {
  const first = {
    ...request,
    offset: 0,
    limit: 10,
    totalCount: 0,
    nextOffset: null,
    incomplete: false,
    entries: []
  }
  const second = { ...first, offset: 10, limit: 20 }
  queries.listInsightsLargestFiles.mockResolvedValueOnce(first)
  queries.listInsightsLargestDirectories.mockResolvedValueOnce(second)
  await expect(insights.listLargest(request, 'file', signal)).resolves.toBe(first)
  await expect(
    insights.listLargest({ ...request, offset: 10, limit: 20 }, 'directory', signal)
  ).resolves.toBe(second)
  expect(queries.listInsightsLargestFiles).toHaveBeenCalledExactlyOnceWith({
    ...request,
    offset: 0,
    limit: 10
  })
  expect(queries.listInsightsLargestDirectories).toHaveBeenCalledExactlyOnceWith({
    ...request,
    offset: 10,
    limit: 20
  })
  await expect(
    insights.listLargest({ ...request, limit: 21 }, 'file', signal)
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(read).toHaveBeenCalledTimes(2)
  queries.listInsightsLargestFiles.mockResolvedValueOnce(second)
  await expect(insights.listLargest(request, 'file', signal)).rejects.toThrow(
    'different ranking page'
  )
  queries.listInsightsLargestFiles.mockResolvedValueOnce({ ...first, scanId: 'replaced' })
  await expect(insights.listLargest(request, 'file', signal)).rejects.toThrow(
    'different publication'
  )
})

test('validates ranked Worker replies with exact safe byte values, matching entry identity and bounded pagination', () => {
  const row = {
    scanId: request.scanId,
    id: 'entry',
    parentId: 'parent',
    type: 'file',
    name: '資料',
    path: 'C:\\資料',
    bytes: null
  }
  const result = {
    ...request,
    entries: [row],
    offset: 0,
    limit: 1,
    nextOffset: 1,
    totalCount: 2,
    incomplete: true
  }
  const reply = { requestId: 1, ok: true, result }
  expect(parseStorageResponse(reply, 1, 'listInsightsLargestFiles')).toEqual(reply)
  expect(() => parseStorageResponse(reply, 1, 'listInsightsLargestDirectories')).toThrow(
    'Invalid response'
  )
  for (const invalid of [
    { ...result, totalCount: 21 },
    { ...result, nextOffset: null },
    { ...result, entries: [] },
    { ...result, entries: [{ ...row, bytes: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...result, entries: [{ ...row, scanId: 'mismatched' }] },
    { ...result, entries: [{ ...row, parentId: null }] }
  ]) {
    expect(() =>
      parseStorageResponse({ ...reply, result: invalid }, 1, 'listInsightsLargestFiles')
    ).toThrow('Invalid response')
  }
})
