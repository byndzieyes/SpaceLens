// @vitest-environment node

import { expect, test, vi, type MockedFunction } from 'vitest'
import type {
  PreparedSnapshotSelection,
  SnapshotSelectionRequest,
  SnapshotSelectionResolution,
  SnapshotView
} from '../src/shared/snapshotSelection'
import { followLatest } from '../src/shared/snapshotSelection'
import { ScanStorageCoordinator } from '../src/main/storage/coordinator'
import type { CommittedSnapshotDeletion } from '../src/main/storage/payloads'
import { SnapshotAccessError } from '../src/main/storage/snapshotAccess'
import { ViewSnapshotSelections } from '../src/main/storage/viewSnapshotSelections'
import {
  STORAGE_REQUEST_TIMEOUT_MS,
  type StorageWorkerClient
} from '../src/main/storage/workerClient'
import { legacyEntries, legacyScan } from './v1-scan-fixture'
import type { ScanSnapshot } from '../src/shared/snapshot'

function explicit(scanId: string, view: SnapshotView = 'explorer'): SnapshotSelectionRequest {
  return { view, selection: { mode: 'explicit', scanId } }
}

interface Fixture {
  state: { latest: string | null; isReady: boolean }
  storage: ScanStorageCoordinator
  document: AbortController
  selections: ViewSnapshotSelections
  prepare: (request: SnapshotSelectionRequest) => Promise<PreparedSnapshotSelection>
  select: (request: SnapshotSelectionRequest) => Promise<SnapshotSelectionResolution>
  metadata: MockedFunction<StorageWorkerClient['getScanHistoryMetadata']>
  openSnapshot: MockedFunction<StorageWorkerClient['openSavedSnapshot']>
  batch: MockedFunction<StorageWorkerClient['applyBatch']>
  deletion: MockedFunction<StorageWorkerClient['deleteSnapshot']>
  prune: MockedFunction<StorageWorkerClient['pruneSnapshot']>
}

function fixture(): Fixture {
  const state = { latest: 'a' as string | null, isReady: true }
  const metadata = vi.fn<StorageWorkerClient['getScanHistoryMetadata']>(async ({ scanId }) => ({
    ...legacyScan,
    id: scanId,
    isLatest: scanId === state.latest,
    durationMs: 900000,
    incomplete: true
  }))
  const snapshot = (scanId: string): ScanSnapshot => {
    const root = { ...legacyEntries.root, scanId }
    return {
      entries: { scanId, rootEntryId: root.id },
      root,
      completedAt: legacyScan.finishedAt,
      summary: legacyScan.summary,
      entryCount: 4,
      incomplete: true
    }
  }
  const discovery = vi.fn<StorageWorkerClient['getScanSnapshot']>(async () => ({
    snapshot: state.latest ? snapshot(state.latest) : null,
    unavailable: null
  }))
  const openSnapshot = vi.fn<StorageWorkerClient['openSavedSnapshot']>(async (id) => snapshot(id))
  const batch = vi.fn<StorageWorkerClient['applyBatch']>(async () => {})
  const deletion = vi.fn<StorageWorkerClient['deleteSnapshot']>(async ({ scanId }) => ({
    scanId,
    latestCompletedScanId: null,
    latestCompleted: null
  }))
  const prune = vi.fn<StorageWorkerClient['pruneSnapshot']>(async () => null)
  const worker = Object.assign(state, {
    waitForExit: () => new Promise<void>(() => {}),
    getScanHistoryMetadata: metadata,
    getScanSnapshot: discovery,
    openSavedSnapshot: openSnapshot,
    deleteSnapshot: deletion,
    pruneSnapshot: prune,
    applyBatch: batch
  }) as unknown as StorageWorkerClient
  const storage = new ScanStorageCoordinator(Promise.resolve(worker))
  const document = new AbortController()
  const selections = new ViewSnapshotSelections(storage, document.signal)
  const prepare: Fixture['prepare'] = (request) => selections.prepare(request, () => true)
  const select: Fixture['select'] = async (request) => {
    const prepared = await prepare(request)
    selections.adopt({ view: request.view, ticket: prepared.ticket })
    return prepared.resolution
  }
  return {
    state,
    storage,
    document,
    selections,
    prepare,
    select,
    metadata,
    openSnapshot,
    batch,
    deletion,
    prune
  }
}

test('protects both sides of a replacement until adoption and discards failed or abandoned candidates', async () => {
  const { storage, document, selections, prepare, select, metadata } = fixture()
  const protectedId = (id: string): boolean => storage.isSnapshotProtected(id)
  try {
    await select(explicit('a'))
    metadata.mockRejectedValueOnce(new SnapshotAccessError('SNAPSHOT_EXPIRED', 'Missing.'))
    await expect(prepare(explicit('missing'))).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' })
    expect(protectedId('missing')).toBe(false)
    expect(protectedId('a')).toBe(true)

    const b = await prepare(explicit('b'))
    expect(protectedId('a')).toBe(true)
    expect(protectedId('b')).toBe(true)
    const c = await prepare(explicit('c'))
    expect(protectedId('b')).toBe(false)
    expect(protectedId('a')).toBe(true)
    expect(() => selections.adopt({ view: 'explorer', ticket: b.ticket })).toThrow(
      'no longer active'
    )
    selections.adopt({ view: 'explorer', ticket: c.ticket })
    expect(protectedId('a')).toBe(false)
    expect(protectedId('c')).toBe(true)

    vi.useFakeTimers()
    const abandoned = await prepare(explicit('d'))
    vi.advanceTimersByTime(STORAGE_REQUEST_TIMEOUT_MS)
    expect(protectedId('d')).toBe(false)
    expect(protectedId('c')).toBe(true)
    expect(() => selections.adopt({ view: 'explorer', ticket: abandoned.ticket })).toThrow(
      'no longer active'
    )
  } finally {
    document.abort()
    vi.useRealTimers()
  }
  expect(protectedId('c')).toBe(false)
})

test('supersedes a dispatched selection without dropping its read reservation early', async () => {
  const { storage, document, selections, prepare, select, metadata } = fixture()
  try {
    await select(explicit('a'))
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof metadata>>>()
    const started = Promise.withResolvers<void>()
    metadata.mockImplementationOnce(() => {
      started.resolve()
      return pending.promise
    })
    const loadingB = prepare(explicit('b'))
    const rejectedB = expect(loadingB).rejects.toThrow('no longer active')
    await started.promise
    const loadingC = prepare(explicit('c'))
    await rejectedB
    expect(['a', 'b', 'c'].map((scanId) => storage.isSnapshotProtected(scanId))).toEqual([
      true,
      true,
      true
    ])
    await expect(storage.deleteSnapshot({ scanId: 'b' })).rejects.toMatchObject({
      code: 'SNAPSHOT_IN_USE'
    })
    pending.resolve({
      ...legacyScan,
      id: 'b',
      isLatest: false,
      durationMs: 900000,
      incomplete: true
    })
    const c = await loadingC
    expect(storage.isSnapshotProtected('b')).toBe(false)
    selections.adopt({ view: 'explorer', ticket: c.ticket })
    expect(storage.isSnapshotProtected('a')).toBe(false)
    expect(storage.isSnapshotProtected('c')).toBe(true)
  } finally {
    document.abort()
  }
})

test('Follow Latest rechecks a publication during validation, and releases the old lease on adoption', async () => {
  const { state, storage, document, selections, prepare, select, metadata } = fixture()
  const follow = { view: 'explorer', selection: followLatest } as const
  try {
    await select(follow)
    state.latest = 'b'
    metadata.mockImplementationOnce(async () => {
      state.latest = 'c'
      return { ...legacyScan, id: 'b', isLatest: false, durationMs: 900000, incomplete: true }
    })
    const prepared = await prepare(follow)
    expect(prepared.resolution).toMatchObject({
      mode: 'follow-latest',
      availability: { snapshot: { entries: { scanId: 'c' } } }
    })
    expect(storage.isSnapshotProtected('b')).toBe(false)
    expect(storage.isSnapshotProtected('a')).toBe(true)
    selections.adopt({ view: 'explorer', ticket: prepared.ticket })
    expect(storage.isSnapshotProtected('a')).toBe(false)
    expect(storage.isSnapshotProtected('c')).toBe(true)
    state.latest = null
    await expect(select(follow)).resolves.toEqual({
      mode: 'follow-latest',
      availability: { snapshot: null, unavailable: null }
    })
    expect(storage.isSnapshotProtected('c')).toBe(false)
  } finally {
    document.abort()
  }
})

test.each(['manual deletion', 'retention pruning'] as const)(
  'rejects acquisition after %s is admitted and protects a winning acquisition',
  async (operation) => {
    const { storage, document, prepare, select, deletion, prune } = fixture()
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const result = { scanId: 'a', latestCompletedScanId: null, latestCompleted: null }
    const mutation = operation === 'manual deletion' ? deletion : prune
    const run = (): Promise<CommittedSnapshotDeletion | null | undefined> =>
      operation === 'manual deletion'
        ? storage.deleteSnapshot({ scanId: 'a' })
        : storage.pruneSnapshotIfIdle('a', 1)
    mutation.mockImplementationOnce(async () => {
      started.resolve()
      await finish.promise
      return result
    })
    try {
      await vi.waitFor(() => expect(storage.retentionIdle).toBe(true))
      const admitted = run()
      await started.promise
      await expect(prepare(explicit('a'))).rejects.toMatchObject({ code: 'SNAPSHOT_IN_USE' })
      finish.resolve()
      await expect(admitted).resolves.toEqual(result)
      await select(explicit('a'))
      await vi.waitFor(() => expect(storage.retentionIdle).toBe(true))
      await expect(run()).rejects.toMatchObject({ code: 'SNAPSHOT_IN_USE' })
      expect(mutation).toHaveBeenCalledOnce()
    } finally {
      finish.resolve()
      document.abort()
    }
  }
)

test('leaving a view releases its lease while an independent queued read remains protected', async () => {
  const { storage, document, selections, select, batch } = fixture()
  await select(explicit('a'))
  const finish = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  batch.mockImplementationOnce(() => {
    started.resolve()
    return finish.promise
  })
  const activeBatch = storage.applyBatch('building', [])
  await started.promise
  const request = new AbortController()
  const inFlight = storage.read(
    request.signal,
    (db) => db.getScanHistoryMetadata({ scanId: 'a' }),
    'a'
  )
  selections.release('explorer')
  expect(storage.isSnapshotProtected('a')).toBe(true)
  finish.resolve()
  await activeBatch
  await inFlight
  expect(storage.isSnapshotProtected('a')).toBe(false)
  document.abort()
})

test('normal handoffs use two owners and leave capacity for two-snapshot consumers', async () => {
  const { storage, document, selections, prepare, select } = fixture()
  try {
    await select(explicit('a'))
    await select(explicit('a', 'insights'))
    await prepare(explicit('b'))
    await prepare(explicit('c', 'insights'))
    const remaining = Array.from({ length: 6 }, () => storage.createSnapshotOwner(document.signal))
    await remaining[0].acquire('a')
    await remaining[0].acquire('b')
    await expect(remaining[0].acquire('c')).rejects.toThrow('at capacity')
    expect(() => storage.createSnapshotOwner(document.signal)).toThrow('protection is unavailable')
    selections.release('explorer')
    expect(storage.isSnapshotProtected('a')).toBe(true)
    remaining[0].dispose()
    expect(storage.isSnapshotProtected('b')).toBe(false)
    for (let visit = 0; visit < 12; visit++) {
      await select(explicit('a'))
      selections.release('explorer')
    }
  } finally {
    document.abort()
  }
  for (const scanId of ['a', 'b', 'c']) expect(storage.isSnapshotProtected(scanId)).toBe(false)
})

test.each(['explorer', 'insights'] as const)(
  'historical %s validation holds request protection after the document is destroyed',
  async (view) => {
    const { storage, document, prepare, openSnapshot } = fixture()
    const dispatched = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const read = openSnapshot.getMockImplementation()!
    openSnapshot.mockImplementationOnce(async (scanId) => {
      dispatched.resolve()
      await finish.promise
      return read(scanId)
    })
    const pending = expect(prepare(explicit('historical', view))).rejects.toThrow(
      'no longer active'
    )
    await dispatched.promise
    document.abort()
    await pending
    expect(storage.isSnapshotProtected('historical')).toBe(true)
    await expect(storage.deleteSnapshot({ scanId: 'historical' })).rejects.toMatchObject({
      code: 'SNAPSHOT_IN_USE'
    })
    finish.resolve()
    await vi.waitFor(() => expect(storage.isSnapshotProtected('historical')).toBe(false))
  }
)
