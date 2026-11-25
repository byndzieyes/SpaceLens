// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { ScanStorageCoordinator } from '../src/main/storage/coordinator'
import type { CommittedSnapshotDeletion } from '../src/main/storage/payloads'
import {
  STORAGE_REQUEST_TIMEOUT_MS,
  StorageWorkerError,
  type StorageWorkerClient
} from '../src/main/storage/workerClient'
import { buildingFixture, legacyScan } from './v1-scan-fixture'

function createStorage(): {
  client: StorageWorkerClient
  storage: ScanStorageCoordinator
  reads: ReturnType<typeof vi.fn<StorageWorkerClient['getScanHistoryMetadata']>>
  deletes: ReturnType<typeof vi.fn<StorageWorkerClient['deleteSnapshot']>>
  batches: ReturnType<typeof vi.fn<StorageWorkerClient['applyBatch']>>
  exit: ReturnType<typeof Promise.withResolvers<void>>
  status: { isReady: boolean }
} {
  const reads = vi.fn<StorageWorkerClient['getScanHistoryMetadata']>(async ({ scanId }) => ({
    ...legacyScan,
    id: scanId,
    durationMs: 900000,
    isLatest: false,
    incomplete: true
  }))
  const deletes = vi.fn<StorageWorkerClient['deleteSnapshot']>(async ({ scanId }) =>
    deleted(scanId)
  )
  const batches = vi.fn<StorageWorkerClient['applyBatch']>(async () => {})
  const exit = Promise.withResolvers<void>()
  const status = { isReady: true }
  const client = Object.assign(status, {
    getScanHistoryMetadata: reads,
    deleteSnapshot: deletes,
    applyBatch: batches,
    waitForExit: () => exit.promise
  }) as unknown as StorageWorkerClient
  return {
    client,
    storage: new ScanStorageCoordinator(Promise.resolve(client)),
    reads,
    deletes,
    batches,
    exit,
    status
  }
}

function deleted(scanId = 'saved'): CommittedSnapshotDeletion {
  return { scanId, latestCompleted: null, latestCompletedScanId: null }
}

test('validates multi-snapshot view leases and releases only the matching owner', async () => {
  const { storage, client, reads } = createStorage()
  const document = new AbortController()
  const explorer = storage.createSnapshotOwner(document.signal)
  const comparison = storage.createSnapshotOwner(document.signal)
  await explorer.acquire('saved')
  await comparison.acquire('saved')
  await comparison.acquire('other')
  expect(reads.mock.calls.map(([request]) => request.scanId)).toEqual(['saved', 'saved', 'other'])
  expect(storage.isSnapshotProtected('saved')).toBe(true)
  expect(storage.isSnapshotProtected('other')).toBe(true)
  expect(new ScanStorageCoordinator(Promise.resolve(client)).isSnapshotProtected('saved')).toBe(
    false
  )
  explorer.release('saved')
  explorer.dispose()
  explorer.dispose()
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).rejects.toMatchObject({
    code: 'SNAPSHOT_IN_USE'
  })
  document.abort()
  expect(storage.isSnapshotProtected('saved')).toBe(false)
  expect(storage.isSnapshotProtected('other')).toBe(false)
  await expect(comparison.acquire('saved')).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).resolves.toEqual(deleted())
})

test.each(['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE'])(
  'failed validation leaves no lease for %s',
  async (code) => {
    const { storage, reads } = createStorage()
    reads.mockRejectedValueOnce(
      new StorageWorkerError({
        name: 'SnapshotAccessError',
        message: 'Could not acquire snapshot.',
        code,
        sqliteCode: null
      })
    )
    const owner = storage.createSnapshotOwner(new AbortController().signal)
    await expect(owner.acquire('invalid')).rejects.toMatchObject({ code })
    expect(storage.isSnapshotProtected('invalid')).toBe(false)
    owner.dispose()
  }
)

test('admitted deletion excludes a later lease and duplicate deletion until the worker settles', async () => {
  const { storage, reads, deletes } = createStorage()
  const pending = Promise.withResolvers<CommittedSnapshotDeletion>()
  deletes.mockReturnValueOnce(pending.promise)
  const attempt = storage.deleteSnapshot({ scanId: 'saved' })
  const owner = storage.createSnapshotOwner(new AbortController().signal)
  await expect(owner.acquire('saved')).rejects.toMatchObject({ code: 'SNAPSHOT_IN_USE' })
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).rejects.toMatchObject({
    code: 'SNAPSHOT_IN_USE'
  })
  await expect(storage.deleteSnapshot({ scanId: 'second' })).rejects.toThrow('already pending')
  expect(reads).not.toHaveBeenCalled()
  expect(deletes).toHaveBeenCalledOnce()
  pending.resolve(deleted())
  await expect(attempt).resolves.toEqual(deleted())
  owner.dispose()
})

test('queued reads protect their ID until dropped, and queued scanner writes precede deletion', async () => {
  const { storage, reads, deletes, batches } = createStorage()
  const working = Promise.withResolvers<void>()
  const dispatched = Promise.withResolvers<void>()
  batches.mockImplementationOnce(() => {
    dispatched.resolve()
    return working.promise
  })
  const active = storage.applyBatch('building', [])
  await dispatched.promise
  const context = new AbortController()
  const read = storage.read(
    context.signal,
    (client) => client.getScanHistoryMetadata({ scanId: 'saved' }),
    'saved'
  )
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).rejects.toMatchObject({
    code: 'SNAPSHOT_IN_USE'
  })
  context.abort()
  await expect(read).rejects.toThrow('no longer active')
  expect(storage.isSnapshotProtected('saved')).toBe(false)
  const deletion = storage.deleteSnapshot({ scanId: 'saved' })
  const nextBatch = storage.applyBatch('building', [])
  working.resolve()
  await Promise.all([active, nextBatch, deletion])
  expect(reads).not.toHaveBeenCalled()
  expect(batches.mock.invocationCallOrder[1]).toBeLessThan(deletes.mock.invocationCallOrder[0])
})

test('keeps a dispatched read protected after its renderer detaches', async () => {
  const { storage, reads } = createStorage()
  const dispatched = Promise.withResolvers<void>()
  const pending =
    Promise.withResolvers<Awaited<ReturnType<StorageWorkerClient['getScanHistoryMetadata']>>>()
  reads.mockImplementationOnce(() => {
    dispatched.resolve()
    return pending.promise
  })
  const context = new AbortController()
  const read = storage.read(
    context.signal,
    (client) => client.getScanHistoryMetadata({ scanId: 'saved' }),
    'saved'
  )
  await dispatched.promise
  context.abort()
  await expect(read).rejects.toThrow('no longer active')
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).rejects.toMatchObject({
    code: 'SNAPSHOT_IN_USE'
  })
  pending.resolve({ ...legacyScan, durationMs: 900000, isLatest: true, incomplete: true })
  await pending.promise
  expect(storage.isSnapshotProtected('saved')).toBe(false)
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).resolves.toEqual(deleted())
})

test('retains protection after a worker timeout until the worker actually exits', async () => {
  const { storage, reads, exit, status } = createStorage()
  const dispatched = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<never>()
  reads.mockImplementationOnce(() => {
    dispatched.resolve()
    return pending.promise
  })
  const read = storage.read(
    new AbortController().signal,
    (client) => client.getScanHistoryMetadata({ scanId: 'saved' }),
    'saved'
  )
  await dispatched.promise
  status.isReady = false
  pending.reject(new Error('Timed out'))
  await expect(read).rejects.toThrow('storage is unavailable')
  expect(storage.isSnapshotProtected('saved')).toBe(true)
  exit.resolve()
  await exit.promise
  expect(storage.isSnapshotProtected('saved')).toBe(false)
})

test('releases a queued protection on its queue deadline without dispatching the expired read', async () => {
  vi.useFakeTimers()
  const { storage, reads, batches } = createStorage()
  const dispatched = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<void>()
  batches.mockImplementationOnce(() => {
    dispatched.resolve()
    return pending.promise
  })
  const write = storage.applyBatch('building', [])
  try {
    await dispatched.promise
    const read = storage.read(
      new AbortController().signal,
      (client) => client.getScanHistoryMetadata({ scanId: 'saved' }),
      'saved'
    )
    const timeout = expect(read).rejects.toThrow('Waiting for saved scan storage timed out')
    expect(storage.isSnapshotProtected('saved')).toBe(true)
    await vi.advanceTimersByTimeAsync(STORAGE_REQUEST_TIMEOUT_MS)
    await timeout
    expect(storage.isSnapshotProtected('saved')).toBe(false)
    const deletion = storage.deleteSnapshot({ scanId: 'saved' })
    pending.resolve()
    await expect(deletion).resolves.toEqual(deleted())
    expect(reads).not.toHaveBeenCalled()
  } finally {
    pending.resolve()
    await write
    vi.useRealTimers()
  }
})

test('a dispatched argument-free read resolves before the queued delete can execute', async () => {
  const { storage, deletes } = createStorage()
  const pending = Promise.withResolvers<string>()
  const dispatched = Promise.withResolvers<void>()
  const read = storage.read(new AbortController().signal, () => {
    dispatched.resolve()
    return pending.promise
  })
  await dispatched.promise
  const deletion = storage.deleteSnapshot({ scanId: 'saved' })
  expect(deletes).not.toHaveBeenCalled()
  pending.resolve('latest-at-dispatch')
  await expect(read).resolves.toBe('latest-at-dispatch')
  await expect(deletion).resolves.toEqual(deleted())
})

test('allows retry after confirmed rollback and closes mutation admission after an uncertain outcome', async () => {
  const { storage, deletes, batches } = createStorage()
  deletes.mockRejectedValueOnce(
    new StorageWorkerError({
      name: 'Error',
      message: 'Rolled back',
      code: null,
      sqliteCode: null
    })
  )
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).rejects.toThrow('Rolled back')
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).resolves.toEqual(deleted())
  deletes.mockRejectedValueOnce(new Error('Lost acknowledgment'))
  await expect(storage.deleteSnapshot({ scanId: 'saved' })).rejects.toMatchObject({
    code: 'SNAPSHOT_DELETE_UNCERTAIN'
  })
  await expect(storage.beginScan(buildingFixture('next'))).rejects.toThrow('storage is unavailable')
  await expect(storage.applyBatch('next', [])).rejects.toThrow('storage is unavailable')
  expect(batches).not.toHaveBeenCalled()
  await expect(storage.deleteSnapshot({ scanId: 'other' })).rejects.toThrow(
    'storage is unavailable'
  )
  expect(deletes).toHaveBeenCalledTimes(3)
})
