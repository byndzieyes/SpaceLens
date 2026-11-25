import { act, renderHook } from '@testing-library/react'
import { expect, test, vi, type MockedFunction } from 'vitest'
import { SnapshotSelections } from '../src/renderer/src/features/snapshots/selection'
import { useSnapshotNavigation } from '../src/renderer/src/features/snapshots/useSnapshotNavigation'
import type { ScanHistoryItem } from '../src/shared/history'
import type { ScannerIpcResult, SpaceLensAPI } from '../src/shared/ipc'
import type { RecentScanSummary } from '../src/shared/scan'
import type { ScanSnapshot } from '../src/shared/snapshot'
import { followLatest, type PreparedSnapshotSelection } from '../src/shared/snapshotSelection'

const timestamp = '2026-11-25T09:00:00.000Z'
const summary = { totalBytes: 0, directoryCount: 1, fileCount: 0, errorCount: 0 }
const explicit = (scanId: string) => ({ mode: 'explicit', scanId }) as const
const recent = (id: string): RecentScanSummary => ({
  ...summary,
  id,
  path: '/fixture',
  completedAt: timestamp
})

function snapshot(scanId: string): ScanSnapshot {
  return {
    entries: { scanId, rootEntryId: 'root' },
    root: {
      scanId,
      id: 'root',
      parentId: null,
      type: 'directory',
      name: 'fixture',
      path: '/fixture',
      sizeBytes: null,
      aggregatedSizeBytes: 0,
      createdAt: null,
      modifiedAt: null
    },
    completedAt: timestamp,
    summary,
    entryCount: 1,
    incomplete: false
  }
}

function metadata(id: string, latest: RecentScanSummary | null): ScanHistoryItem {
  return {
    id,
    rootPath: '/fixture',
    status: 'completed',
    startedAt: timestamp,
    finishedAt: timestamp,
    summary,
    durationMs: 0,
    isLatest: id === latest?.id,
    incomplete: false
  }
}

const ok = <T,>(value: T): ScannerIpcResult<T> => ({ ok: true, value })

function fixture(): {
  selections: SnapshotSelections
  prepare: MockedFunction<SpaceLensAPI['prepareSnapshotSelection']>
  adopt: MockedFunction<SpaceLensAPI['adoptSnapshotSelection']>
  release: MockedFunction<SpaceLensAPI['releaseSnapshotSelection']>
  announce: (revision: number, id: string | null) => void
  ok: typeof ok
} {
  const state = { latest: null as RecentScanSummary | null }
  const prepare = vi.fn<SpaceLensAPI['prepareSnapshotSelection']>(async ({ selection }) => {
    if (selection.mode === 'explicit')
      return ok({
        ticket: selection.scanId,
        resolution: { mode: 'explicit', metadata: metadata(selection.scanId, state.latest) }
      })
    return ok({
      ticket: state.latest?.id ?? 'empty',
      resolution: {
        mode: 'follow-latest',
        availability: {
          snapshot: state.latest ? snapshot(state.latest.id) : null,
          unavailable: null
        }
      }
    })
  })
  const adopt = vi.fn<SpaceLensAPI['adoptSnapshotSelection']>(async () => ok(null))
  const release = vi.fn<SpaceLensAPI['releaseSnapshotSelection']>(async () => ok(null))
  const selections = new SnapshotSelections({
    prepareSnapshotSelection: prepare,
    adoptSnapshotSelection: adopt,
    releaseSnapshotSelection: release,
    onScanStateChanged: vi.fn(() => () => {})
  })
  const announce = (revision: number, id: string | null): void => {
    state.latest = id ? recent(id) : null
    selections.observeScanState({
      revision,
      state: null,
      latestCompleted: state.latest,
      historyRevision: revision
    })
  }
  return { selections, prepare, adopt, release, announce, ok }
}

test('keeps explicit selection of Latest independent from subsequent Latest and other views', async () => {
  const { selections, announce, prepare } = fixture()
  expect(selections.get('explorer')).toBeUndefined()
  await expect(selections.select('explorer', followLatest)).resolves.toMatchObject({
    status: 'empty'
  })
  announce(1, 'a')
  await expect(selections.select('explorer', followLatest)).resolves.toMatchObject({
    status: 'resolved',
    resolution: { availability: { snapshot: { entries: { scanId: 'a' } } } }
  })
  const chosen = await selections.select('explorer', explicit('a'))
  announce(2, 'b')
  await selections.select('insights', followLatest)
  expect(chosen).toMatchObject({
    status: 'resolved',
    selection: explicit('a'),
    resolution: { metadata: { id: 'a' } }
  })
  expect(selections.get('explorer')).toBe(chosen)
  expect(selections.latestCompleted?.id).toBe('b')
  expect(selections.get('insights')).toMatchObject({
    resolution: { availability: { snapshot: { entries: { scanId: 'b' } } } }
  })
  announce(3, 'b')
  expect(selections.get('explorer')).toBe(chosen)
  expect(prepare).toHaveBeenCalledTimes(4)
  await expect(selections.select('explorer', followLatest)).resolves.toMatchObject({
    status: 'resolved',
    selection: followLatest,
    resolution: { availability: { snapshot: { entries: { scanId: 'b' } } } }
  })
})

test('distinguishes unavailable explicit selections from failures and empty history', async () => {
  const { selections, prepare, announce } = fixture()
  announce(1, 'current')
  prepare.mockResolvedValueOnce({
    ok: false,
    error: { code: 'SNAPSHOT_EXPIRED', message: 'Missing.' }
  })
  await expect(selections.select('explorer', explicit('missing'))).resolves.toMatchObject({
    status: 'unavailable',
    selection: explicit('missing')
  })
  expect(selections.latestCompleted?.id).toBe('current')
  prepare.mockRejectedValueOnce(new Error('private error'))
  await expect(selections.select('explorer', explicit('other'))).resolves.toMatchObject({
    status: 'failed',
    error: { code: 'UNAVAILABLE' }
  })
  expect(
    await selections.loadForCurrentView('explorer', explicit('other'), () => true)
  ).toMatchObject({
    ok: false,
    error: { code: 'SNAPSHOT_UNAVAILABLE' }
  })
})

test('ignores a stale preparation and does not adopt it or overwrite the current selection', async () => {
  const { selections, prepare, adopt, ok } = fixture()
  const late = Promise.withResolvers<ScannerIpcResult<PreparedSnapshotSelection>>()
  await selections.select('explorer', explicit('a'))
  prepare.mockReturnValueOnce(late.promise)
  const b = selections.select('explorer', explicit('b'))
  expect(selections.get('explorer')).toEqual({ status: 'pending', selection: explicit('b') })
  const c = await selections.select('explorer', explicit('c'))
  late.resolve(ok({ ticket: 'b', resolution: { mode: 'explicit', metadata: metadata('b', null) } }))
  await expect(b).resolves.toBeUndefined()
  expect(selections.get('explorer')).toBe(c)
  expect(adopt.mock.calls).toEqual([
    [{ view: 'explorer', ticket: 'a' }],
    [{ view: 'explorer', ticket: 'c' }]
  ])
})

test('opens an explicit destination immediately and retains its source until destination adoption', async () => {
  const { selections, adopt, release, ok } = fixture()
  const { result, unmount } = renderHook(() => useSnapshotNavigation(selections))
  expect(result.current.destination.page).toBe('overview')
  expect(result.current.viewOptions.selection).toBe(followLatest)
  act(() => result.current.navigate('insights'))
  await selections.select('insights', explicit('a'))
  const waiting = Promise.withResolvers<ScannerIpcResult<null>>()
  adopt.mockReturnValueOnce(waiting.promise)
  const entry = { scanId: 'a', entryId: 'leaf', parentId: 'root', type: 'directory' } as const
  act(() =>
    result.current.navigateToSnapshot({ view: 'explorer', selection: explicit('a'), entry })
  )
  expect(result.current.destination).toMatchObject({ page: 'explorer', target: entry })
  expect(result.current.viewOptions.selection).toEqual(explicit('a'))
  expect(release).not.toHaveBeenCalled()
  await act(async () => waiting.resolve(ok(null)))
  expect(await result.current.viewOptions.handoff).toMatchObject({ status: 'resolved' })
  expect(release).toHaveBeenCalledExactlyOnceWith({ view: 'insights' })
  act(() => result.current.consumeTarget(entry))
  expect(result.current.destination.target).toBeUndefined()
  act(() => result.current.navigate('explorer'))
  expect(result.current.viewOptions.selection).toBe(followLatest)
  unmount()
  expect(release).toHaveBeenLastCalledWith({ view: 'explorer' })
})

test('keeps one rapid handoff and abandons both holds when the user leaves', async () => {
  const { selections, prepare, adopt, release, ok } = fixture()
  const { result } = renderHook(() => useSnapshotNavigation(selections))
  act(() => result.current.navigate('insights'))
  await selections.select('insights', explicit('a'))
  const first = Promise.withResolvers<ScannerIpcResult<PreparedSnapshotSelection>>()
  const second = Promise.withResolvers<ScannerIpcResult<PreparedSnapshotSelection>>()
  prepare.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  act(() => result.current.navigateToSnapshot({ view: 'explorer', selection: explicit('b') }))
  act(() => result.current.navigateToSnapshot({ view: 'explorer', selection: explicit('a') }))
  expect(release).not.toHaveBeenCalled()
  expect(result.current.viewOptions.selection).toEqual(explicit('a'))
  act(() => result.current.navigate('history'))
  expect(result.current.destination.page).toBe('history')
  expect(release.mock.calls).toEqual([[{ view: 'insights' }], [{ view: 'explorer' }]])
  await act(async () => {
    second.resolve(
      ok({ ticket: 'new', resolution: { mode: 'explicit', metadata: metadata('a', null) } })
    )
    first.resolve(
      ok({ ticket: 'old', resolution: { mode: 'explicit', metadata: metadata('b', null) } })
    )
  })
  expect(result.current.destination.page).toBe('history')
  expect(adopt).toHaveBeenCalledExactlyOnceWith({ view: 'insights', ticket: 'a' })
  expect(selections.get('explorer')).toBeUndefined()
  expect(selections.get('insights')).toBeUndefined()
})
