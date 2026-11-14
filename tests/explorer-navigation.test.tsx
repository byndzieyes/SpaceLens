import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FileEntry } from '../src/shared/scan'
import type { ScanSnapshot } from '../src/shared/snapshot'
import type { SpaceLensAPI } from '../src/shared/ipc'
import { useExplorer } from '../src/renderer/src/features/explorer/useExplorer'
const root: FileEntry = {
  id: 'root',
  scanId: 'scan',
  parentId: null,
  name: 'root',
  path: '/root',
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 0,
  createdAt: null,
  modifiedAt: null
}
const child = { ...root, id: 'child', parentId: 'root', name: 'child', path: '/root/child' }
const leaf = { ...child, id: 'leaf', parentId: 'child' }
const snapshot: ScanSnapshot = {
  entries: { scanId: 'scan', rootEntryId: 'root' },
  root,
  completedAt: '2026-11-14T00:00:00Z',
  summary: { fileCount: 0, directoryCount: 3, totalBytes: 0, errorCount: 1 },
  entryCount: 3,
  incomplete: true
}
const api = {
  getScanSnapshot: vi.fn<SpaceLensAPI['getScanSnapshot']>(),
  getScanEntry: vi.fn<SpaceLensAPI['getScanEntry']>()
}
beforeEach(() => {
  vi.resetAllMocks()
  api.getScanSnapshot.mockResolvedValue({
    ok: true,
    value: { snapshot, unavailable: { scanId: 'newer', reason: 'limit-exceeded' } }
  })
  api.getScanEntry.mockImplementation(async ({ entryId }) => ({
    ok: true,
    value: entryId === 'child' ? child : leaf
  }))
  vi.stubGlobal('spaceLens', api)
})
afterEach(() => vi.unstubAllGlobals())
async function mount(): Promise<RenderHookResult<ReturnType<typeof useExplorer>, unknown>> {
  const hook = renderHook(useExplorer)
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}
test('initializes the retained root with incomplete and newer summary-only metadata', async () => {
  const { result } = await mount()
  expect(result.current.currentDirectoryId).toBe('root')
  expect(result.current.availability).toMatchObject({
    status: 'available',
    snapshot: { incomplete: true },
    unavailable: { scanId: 'newer' }
  })
  expect(api.getScanEntry).not.toHaveBeenCalled()
})
test.each([null, { scanId: 'newer', reason: 'limit-exceeded' as const }])(
  'handles absence %o',
  async (unavailable) => {
    api.getScanSnapshot.mockResolvedValue({ ok: true, value: { snapshot: null, unavailable } })
    const { result } = await mount()
    expect(result.current.currentDirectoryId).toBeNull()
    expect(result.current.availability?.status).toBe(unavailable ? 'summary-only' : 'missing')
  }
)
test('validates hierarchy, history, ancestor navigation and selection', async () => {
  const { result } = await mount()
  act(() => result.current.selectEntry('item'))
  await act(() => result.current.navigateToDirectory('leaf'))
  expect(result.current.breadcrumbs.map((e) => e.id)).toEqual(['root', 'child', 'leaf'])
  expect(result.current.selectedEntryId).toBeNull()
  await act(async () => {
    await result.current.goBack()
  })
  expect(result.current.currentDirectoryId).toBe('root')
  await act(async () => {
    await result.current.goForward()
  })
  expect(result.current.currentDirectoryId).toBe('leaf')
  await act(async () => {
    await result.current.goUp()
  })
  expect(result.current.currentDirectoryId).toBe('child')
  expect(result.current.forward).toEqual([])
  const history = result.current.back
  await act(() => result.current.navigateToDirectory('child'))
  expect(result.current.back).toEqual(history)
})
test.each(['file', 'outside', 'cycle', 'foreign'])(
  'rejects %s without losing valid state',
  async (kind) => {
    const { result } = await mount()
    api.getScanEntry.mockResolvedValue({
      ok: true,
      value: {
        ...child,
        type: kind === 'file' ? 'file' : 'directory',
        parentId: kind === 'outside' ? null : 'child',
        scanId: kind === 'foreign' ? 'other' : 'scan'
      }
    })
    await act(() => result.current.navigateToDirectory('child'))
    expect(result.current.currentDirectoryId).toBe('root')
    expect(result.current.error).not.toBeNull()
    expect(result.current.back).toEqual([])
  }
)
test('replacement resets navigation and selection', async () => {
  const { result } = await mount()
  await act(() => result.current.navigateToDirectory('child'))
  act(() => result.current.selectEntry('item'))
  api.getScanSnapshot.mockResolvedValue({
    ok: true,
    value: {
      snapshot: {
        ...snapshot,
        entries: { scanId: 'next', rootEntryId: 'root' },
        root: { ...root, scanId: 'next' }
      },
      unavailable: null
    }
  })
  await act(() => result.current.refreshSnapshot())
  expect(result.current.currentDirectoryId).toBe('root')
  expect(result.current.back).toEqual([])
  expect(result.current.selectedEntryId).toBeNull()
})
test.each(['ENTRY_NOT_FOUND', 'SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE'] as const)(
  'preserves %s and refreshes stale availability',
  async (code) => {
    const { result } = await mount()
    const error = { code, message: 'Original message' }
    api.getScanEntry.mockResolvedValue({ ok: false, error })
    await act(() => result.current.navigateToDirectory('child'))
    expect(result.current.error).toEqual(error)
    expect(result.current.currentDirectoryId).toBe('root')
    expect(api.getScanSnapshot).toHaveBeenCalledTimes(code === 'ENTRY_NOT_FOUND' ? 1 : 2)
  }
)
test('ignores out-of-order navigation and responses from a replaced snapshot', async () => {
  const { result } = await mount()
  let finish!: (value: Awaited<ReturnType<SpaceLensAPI['getScanEntry']>>) => void
  api.getScanEntry.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  let pending!: Promise<void>
  act(() => {
    pending = result.current.navigateToDirectory('leaf')
  })
  await act(() => result.current.navigateToDirectory('child'))
  await act(async () => {
    finish({ ok: true, value: leaf })
    await pending
  })
  expect(result.current.currentDirectoryId).toBe('child')
})
test('transport errors preserve state and reactivation re-queries availability', async () => {
  const hook = await mount()
  api.getScanEntry.mockRejectedValue(new Error('connection'))
  await act(() => hook.result.current.navigateToDirectory('child'))
  expect(hook.result.current.error?.code).toBe('TRANSPORT_ERROR')
  expect(hook.result.current.currentDirectoryId).toBe('root')
  hook.unmount()
  await mount()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
})

test('an old snapshot response cannot overwrite a replacement', async () => {
  const { result } = await mount()
  let finish!: (value: Awaited<ReturnType<SpaceLensAPI['getScanEntry']>>) => void
  api.getScanEntry.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  let pending!: Promise<void>
  act(() => {
    pending = result.current.navigateToDirectory('child')
  })
  api.getScanSnapshot.mockResolvedValue({
    ok: true,
    value: {
      snapshot: {
        ...snapshot,
        entries: { scanId: 'replacement', rootEntryId: 'root' },
        root: { ...root, scanId: 'replacement' }
      },
      unavailable: null
    }
  })
  await act(() => result.current.refreshSnapshot())
  await act(async () => {
    finish({ ok: true, value: child })
    await pending
  })
  expect(result.current.currentDirectoryId).toBe('root')
  expect(result.current.availability).toMatchObject({
    snapshot: { entries: { scanId: 'replacement' } }
  })
  expect(result.current.back).toEqual([])
})
