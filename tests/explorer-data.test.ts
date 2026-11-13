import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ScannerIpcErrorCode, ScannerIpcResult, SpaceLensAPI } from '../src/shared/ipc'
import type { FileEntry } from '../src/shared/scan'
import type { ScanDirectoryPage, ScanSnapshot } from '../src/shared/snapshot'
import {
  listExplorerDirectoryPage,
  resolveExplorerSnapshot
} from '../src/renderer/src/features/explorer/data'

const root: FileEntry = {
  id: 'root',
  scanId: 'published',
  parentId: null,
  path: 'C:\\Test folders\\Україна & notes',
  name: 'Україна & notes',
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 12,
  createdAt: null,
  modifiedAt: null
}
const snapshot: ScanSnapshot = {
  entries: { scanId: root.scanId, rootEntryId: root.id },
  root,
  completedAt: '2026-11-13T10:00:00Z',
  summary: { totalBytes: 12, fileCount: 3, directoryCount: 1, errorCount: 0 },
  entryCount: 4,
  incomplete: false
}
const directory = { scanId: root.scanId, entryId: root.id }
const api = {
  getScanSnapshot: vi.fn<SpaceLensAPI['getScanSnapshot']>(),
  getScanEntry: vi.fn<SpaceLensAPI['getScanEntry']>(),
  listScanDirectory: vi.fn<SpaceLensAPI['listScanDirectory']>()
} satisfies Pick<SpaceLensAPI, 'getScanSnapshot' | 'getScanEntry' | 'listScanDirectory'>

function failure(code: ScannerIpcErrorCode): ScannerIpcResult<never> {
  return { ok: false, error: { code, message: `Original ${code} message` } }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('spaceLens', api)
})
afterEach(() => vi.unstubAllGlobals())

test.each([false, true])(
  'resolves published metadata, preserving incomplete=%s',
  async (incomplete) => {
    const metadata: ScanSnapshot = {
      ...snapshot,
      incomplete,
      summary: { ...snapshot.summary, errorCount: incomplete ? 1 : 0 }
    }
    api.getScanSnapshot.mockResolvedValue({
      ok: true,
      value: { snapshot: metadata, unavailable: null }
    })

    const result = await resolveExplorerSnapshot()
    expect(result).toEqual({
      ok: true,
      value: { status: 'available', snapshot: metadata, unavailable: null }
    })
    if (!result.ok || result.value.status !== 'available') throw new Error('Expected snapshot')
    expect(result.value.snapshot).toBe(metadata)
    expect(api.getScanSnapshot).toHaveBeenCalledExactlyOnceWith()
    expect(api.getScanEntry).not.toHaveBeenCalled()
    expect(api.listScanDirectory).not.toHaveBeenCalled()
  }
)

test('represents absence without inventing a scan, summary, or root', async () => {
  api.getScanSnapshot.mockResolvedValue({ ok: true, value: { snapshot: null, unavailable: null } })
  expect(await resolveExplorerSnapshot()).toEqual({
    ok: true,
    value: { status: 'missing', snapshot: null, unavailable: null }
  })
})

test.each(['limit-exceeded', 'invalid-data'] as const)(
  'distinguishes summary-only retention failure: %s',
  async (reason) => {
    const unavailable = { scanId: 'newer', reason }
    api.getScanSnapshot.mockResolvedValue({ ok: true, value: { snapshot: null, unavailable } })
    expect(await resolveExplorerSnapshot()).toEqual({
      ok: true,
      value: { status: 'summary-only', snapshot: null, unavailable }
    })
    expect(api.getScanEntry).not.toHaveBeenCalled()
    expect(api.listScanDirectory).not.toHaveBeenCalled()
  }
)

test('keeps an older snapshot browsable alongside a newer summary-only scan', async () => {
  const unavailable = { scanId: 'newer', reason: 'limit-exceeded' } as const
  api.getScanSnapshot.mockResolvedValue({ ok: true, value: { snapshot, unavailable } })
  api.getScanEntry.mockResolvedValue({ ok: true, value: root })
  const result = await resolveExplorerSnapshot()
  if (!result.ok || result.value.status !== 'available') throw new Error('Expected snapshot')
  expect(result.value.unavailable).toBe(unavailable)

  // Entry lookup deliberately reuses preload; the published IDs, not the latest
  // completed scan ID or a filesystem path, identify the root to query.
  const entry = await window.spaceLens.getScanEntry({
    scanId: result.value.snapshot.entries.scanId,
    entryId: result.value.snapshot.root.id
  })
  expect(api.getScanEntry).toHaveBeenCalledExactlyOnceWith(directory)
  expect(entry).toEqual({ ok: true, value: root })
})

test('re-queries availability instead of caching a replaced snapshot', async () => {
  const replacement: ScanSnapshot = {
    ...snapshot,
    entries: { scanId: 'replacement', rootEntryId: 'new-root' },
    root: { ...root, scanId: 'replacement', id: 'new-root' }
  }
  api.getScanSnapshot
    .mockResolvedValueOnce({ ok: true, value: { snapshot, unavailable: null } })
    .mockResolvedValueOnce({ ok: true, value: { snapshot: replacement, unavailable: null } })
  expect(await resolveExplorerSnapshot()).toMatchObject({ value: { snapshot } })
  expect(await resolveExplorerSnapshot()).toMatchObject({ value: { snapshot: replacement } })
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
})

test('loads one default page without reordering, copying entries, or following nextOffset', async () => {
  const entries: readonly FileEntry[] = Object.freeze(
    [
      ['z', 'A'],
      ['a', 'same'],
      ['b', 'same'],
      ['c', 'Я'],
      ...Array.from({ length: 96 }, (_, index) => [
        `extra-${index}`,
        `Я${index.toString().padStart(3, '0')}`
      ])
    ].map(([id, name]) =>
      Object.freeze({
        ...root,
        id,
        name,
        parentId: root.id,
        type: 'file' as const,
        path: `${root.path}\\${name}`,
        sizeBytes: 4,
        aggregatedSizeBytes: null
      })
    )
  )
  const page: ScanDirectoryPage = Object.freeze({
    scanId: root.scanId,
    directoryId: root.id,
    entries,
    totalCount: 204,
    nextOffset: 100
  })
  const response = { ok: true, value: page } as const
  api.listScanDirectory.mockResolvedValue(response)

  expect(await listExplorerDirectoryPage(directory)).toBe(response)
  expect(api.listScanDirectory).toHaveBeenCalledExactlyOnceWith({
    ...directory,
    offset: 0,
    limit: 100
  })
  expect(api.getScanSnapshot).not.toHaveBeenCalled()
})

test.each([
  { offset: 0, limit: 1, count: 1, nextOffset: 1 },
  { offset: 100, limit: 100, count: 1, nextOffset: null },
  { offset: 101, limit: 100, count: 0, nextOffset: null },
  { offset: Number.MAX_SAFE_INTEGER, limit: 1, count: 0, nextOffset: null }
])(
  'preserves explicit pagination and terminal pages: %o',
  async ({ offset, limit, count, nextOffset }) => {
    const page: ScanDirectoryPage = {
      scanId: root.scanId,
      directoryId: root.id,
      entries: count ? [{ ...root, id: 'child', parentId: root.id }] : [],
      totalCount: 101,
      nextOffset
    }
    const response = { ok: true, value: page } as const
    api.listScanDirectory.mockResolvedValue(response)
    expect(await listExplorerDirectoryPage(directory, { offset, limit })).toBe(response)
    expect(api.listScanDirectory).toHaveBeenCalledExactlyOnceWith({ ...directory, offset, limit })
  }
)

test.each([{ offset: 5 }, { limit: 1 }])(
  'defaults omitted pagination fields independently: %o',
  async (pagination) => {
    api.listScanDirectory.mockResolvedValue(failure('ENTRY_NOT_FOUND'))
    await listExplorerDirectoryPage(directory, pagination)
    expect(api.listScanDirectory).toHaveBeenCalledExactlyOnceWith({
      ...directory,
      offset: 0,
      limit: 100,
      ...pagination
    })
  }
)

test.each([
  ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((offset) => ({ offset })),
  ...[0, -1, 101, 1.5, NaN, Infinity].map((limit) => ({ limit }))
])('rejects invalid pagination without clamping or sending IPC: %o', async (pagination) => {
  expect(await listExplorerDirectoryPage(directory, pagination)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST', message: expect.any(String) }
  })
  expect(api.listScanDirectory).not.toHaveBeenCalled()
})

test.each([
  'SNAPSHOT_UNAVAILABLE',
  'SNAPSHOT_EXPIRED',
  'ENTRY_NOT_FOUND',
  'NOT_DIRECTORY',
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'UNAVAILABLE',
  'INTERNAL_ERROR'
] satisfies ScannerIpcErrorCode[])(
  'preserves structured %s failures without retrying or replacing scan IDs',
  async (code) => {
    const response = failure(code)
    api.getScanSnapshot.mockResolvedValue(response)
    expect(await resolveExplorerSnapshot()).toBe(response)
    api.getScanSnapshot.mockClear()

    api.listScanDirectory.mockResolvedValue(response)
    expect(await listExplorerDirectoryPage(directory)).toBe(response)
    expect(api.listScanDirectory).toHaveBeenCalledExactlyOnceWith({
      ...directory,
      offset: 0,
      limit: 100
    })
    expect(api.getScanSnapshot).not.toHaveBeenCalled()
  }
)

test('does not turn transport rejection into successful empty data or an invented IPC error', async () => {
  const error = new Error('IPC connection lost')
  api.getScanSnapshot.mockRejectedValue(error)
  api.listScanDirectory.mockRejectedValue(error)
  await expect(resolveExplorerSnapshot()).rejects.toBe(error)
  await expect(listExplorerDirectoryPage(directory)).rejects.toBe(error)
})
