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
