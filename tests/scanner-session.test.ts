// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest'
import { resolve } from 'node:path'
import type { FileEntry } from '../src/shared/scan'
import { ScanCancelledError } from '../src/main/scanner/cancellation'
import {
  ScanSessionManager,
  type ScanSessionState,
  type ScanSessionSubscriber
} from '../src/main/scanner/sessionManager'
import { runScannerWorker } from '../src/main/scanner/workerRunner'
import type { ScanEventConsumer, ScannerWorkerOptions } from '../src/main/scanner/workerClient'
import type { ScanSummaryEvent } from '../src/main/scanner/summary'
import { StorageWorkerError } from '../src/main/storage/workerClient'
import { ScanStorageError, type ScanPersistence } from '../src/main/scanner/persistence'

vi.mock('../src/main/scanner/workerRunner', () => ({ runScannerWorker: vi.fn() }))

interface Run {
  path: string
  id: string
  consume: ScanEventConsumer
  options: ScannerWorkerOptions
  resolve: (summary: ScanSummaryEvent) => void
  reject: (error: unknown) => void
}
const runs: Run[] = []
const managers: ScanSessionManager[] = []
const rootPath = resolve('session-fixture')

beforeEach(() => {
  runs.length = 0
  vi.mocked(runScannerWorker).mockImplementation(
    (path, id, consume, options) =>
      new Promise((resolve, reject) => {
        if (typeof options === 'function') throw new Error('Expected manager options')
        runs.push({ path, id, consume, options: options!, resolve, reject })
      })
  )
})

afterEach(async () => {
  for (const manager of managers) manager.cancel()
  for (const run of runs) run.reject(new ScanCancelledError())
  await Promise.all(managers.map((manager) => manager.dispose()))
  managers.length = 0
  vi.restoreAllMocks()
})

function manager(): ScanSessionManager {
  const instance = new ScanSessionManager()
  managers.push(instance)
  return instance
}

function storageMock(): { [K in keyof ScanPersistence]: Mock<ScanPersistence[K]> } {
  return {
    beginScan: vi.fn<ScanPersistence['beginScan']>().mockResolvedValue(undefined),
    applyBatch: vi.fn<ScanPersistence['applyBatch']>().mockResolvedValue(undefined),
    publishScan: vi.fn<ScanPersistence['publishScan']>().mockResolvedValue(undefined),
    discardBuildingScan: vi
      .fn<ScanPersistence['discardBuildingScan']>()
      .mockResolvedValue(undefined)
  }
}

function persistentManager(ready: Promise<ScanPersistence>): ScanSessionManager {
  const instance = new ScanSessionManager(undefined, ready)
  managers.push(instance)
  return instance
}

const storageRejection = (): StorageWorkerError =>
  new StorageWorkerError({
    name: 'Error',
    message: 'Constraint rejected the write',
    code: 'ERR_SQLITE_ERROR',
    sqliteCode: 787
  })

async function launch(
  instance: ScanSessionManager
): Promise<{ scanId: string; done: Promise<ScanSessionState>; run: Run }> {
  const accepted = await instance.launch(rootPath, async () => {})
  return { ...accepted, run: runs.at(-1)! }
}

test('waits for startup recovery and a building row before accepting or traversing', async () => {
  const storage = storageMock()
  const recovery = Promise.withResolvers<void>()
  const building = Promise.withResolvers<void>()
  storage.beginScan.mockReturnValueOnce(building.promise)
  const instance = persistentManager(recovery.promise.then(() => storage))
  const confirm = vi.fn(async () => {})
  const accepted = instance.launch(rootPath, confirm)
  await Promise.resolve()
  expect(storage.beginScan).not.toHaveBeenCalled()
  expect(instance.getState()).toBeNull()
  await expect(instance.start(rootPath)).rejects.toThrow('already active')
  expect(confirm).not.toHaveBeenCalled()
  recovery.resolve()
  await vi.waitFor(() => expect(storage.beginScan).toHaveBeenCalledOnce())
  expect(instance.getState()).toBeNull()
  expect(runScannerWorker).not.toHaveBeenCalled()
  building.resolve()
  const { scanId, done } = await accepted
  expect(confirm).toHaveBeenCalledOnce()
  expect(storage.beginScan).toHaveBeenCalledWith(expect.objectContaining({ id: scanId, rootPath }))
  expect(runs[0].id).toBe(scanId)
  instance.cancel()
  runs[0].reject(new ScanCancelledError())
  expect((await done).session.status).toBe('cancelled')
  expect(storage.discardBuildingScan).toHaveBeenCalledExactlyOnceWith(scanId)
})

test('failed recovery prevents every scan start before authorization or traversal', async () => {
  const storage = storageMock()
  const recovery = Promise.withResolvers<void>()
  const instance = persistentManager(recovery.promise.then(() => storage))
  const confirm = vi.fn(async () => {})
  const error = new ScanStorageError('recovering scan storage', new Error('Invalid publication'))
  const accepted = expect(instance.launch(rootPath, confirm)).rejects.toBe(error)
  recovery.reject(error)
  await accepted
  await expect(instance.launch(rootPath, confirm)).rejects.toBe(error)
  expect(storage.beginScan).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
  expect(runScannerWorker).not.toHaveBeenCalled()
  expect(instance.getLatestCompleted()).toBeNull()
})

test('rejects initialization and begin failures before acknowledging the start', async () => {
  const storage = storageMock()
  const ready = Promise.withResolvers<ScanPersistence>()
  const broken = persistentManager(ready.promise)
  const init = expect(launch(broken)).rejects.toThrow('initializing scan storage')
  ready.reject(new Error('Database initialization failed'))
  await init
  const instance = persistentManager(Promise.resolve(storage))
  storage.beginScan.mockRejectedValueOnce(storageRejection())
  await expect(launch(instance)).rejects.toThrow('starting the scan')
  expect(instance.getState()).toBeNull()
  expect(storage.discardBuildingScan).not.toHaveBeenCalled()
  expect(runScannerWorker).not.toHaveBeenCalled()
})

test('cancels before the storage worker is ready without creating a building row', async () => {
  const ready = Promise.withResolvers<ScanPersistence>()
  const storage = storageMock()
  const instance = persistentManager(ready.promise)
  const accepted = expect(launch(instance)).rejects.toBeInstanceOf(ScanCancelledError)
  expect(instance.cancel()).toBe(true)
  ready.resolve(storage)
  await accepted
  expect(storage.beginScan).not.toHaveBeenCalled()
  expect(storage.discardBuildingScan).not.toHaveBeenCalled()
  expect(runScannerWorker).not.toHaveBeenCalled()
})

test('persists an empty batch for a recoverable error without dropping its progress accounting', async () => {
  const storage = storageMock()
  const instance = persistentManager(Promise.resolve(storage))
  const { run, done, scanId } = await launch(instance)
  const event = {
    type: 'error' as const,
    error: { path: rootPath, code: 'EACCES', message: 'Denied' }
  }
  await run.consume(event)
  await run.options.beforeAck!([event])
  expect(storage.applyBatch).toHaveBeenCalledExactlyOnceWith(scanId, [])
  await root(run)
  await finish(instance, run)
  expect(await done).toMatchObject({ session: { status: 'completed', summary: { errorCount: 1 } } })
  expect(storage.publishScan).toHaveBeenCalledWith(
    expect.objectContaining({ summary: expect.objectContaining({ errorCount: 1 }) }),
    'directory'
  )
})

test('shutdown can stop pending authorization after begin and only discards its own row', async () => {
  const storage = storageMock()
  const instance = persistentManager(Promise.resolve(storage))
  const waiting = Promise.withResolvers<void>()
  const confirm = vi.fn(() => waiting.promise)
  const accepted = expect(instance.launch(rootPath, confirm)).rejects.toBeInstanceOf(
    ScanCancelledError
  )
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  await instance.dispose()
  await accepted
  expect(storage.discardBuildingScan).toHaveBeenCalledExactlyOnceWith(
    storage.beginScan.mock.calls[0][0].id
  )
  expect(runScannerWorker).not.toHaveBeenCalled()
  waiting.resolve()
})

test('waits for a batch that outlives cancellation before discarding and ignores stale callbacks', async () => {
  const storage = storageMock()
  const pending = Promise.withResolvers<void>()
  storage.applyBatch.mockReturnValueOnce(pending.promise)
  const instance = persistentManager(Promise.resolve(storage))
  const first = await launch(instance)
  const discovery = { type: 'entry' as const, entry: entry(first.run, 'directory') }
  await first.run.consume(discovery)
  const batch = first.run.options.beforeAck!([discovery])
  expect(storage.applyBatch).toHaveBeenCalledExactlyOnceWith(first.scanId, [discovery])
  expect(instance.cancel()).toBe(true)
  first.run.reject(new ScanCancelledError())
  await vi.waitFor(() => expect(instance.getState()?.session.status).toBe('running'))
  expect(storage.discardBuildingScan).not.toHaveBeenCalled()
  await expect(instance.start(rootPath)).rejects.toThrow('already active')
  pending.resolve()
  await batch
  expect((await first.done).session.status).toBe('cancelled')
  expect(storage.discardBuildingScan).toHaveBeenCalledExactlyOnceWith(first.scanId)

  const next = await launch(instance)
  await first.run.options.beforeAck!([discovery])
  await first.run.consume(discovery)
  expect(storage.applyBatch).toHaveBeenCalledOnce()
  expect(instance.getState()?.session.id).toBe(next.scanId)
  instance.cancel()
  next.run.reject(new ScanCancelledError())
  await next.done
})

test.each(['batch', 'publication'] as const)(
  'does not discard or replay an uncertain %s write',
  async (stage) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = storageMock()
    const instance = persistentManager(Promise.resolve(storage))
    const earlier = await launch(instance)
    await root(earlier.run)
    await finish(instance, earlier.run)
    expect((await earlier.done).session.status).toBe('completed')
    const previousSnapshot = instance.getScanSnapshot().snapshot
    expect(previousSnapshot?.entries.scanId).toBe(earlier.scanId)
    storage.publishScan.mockClear()
    const { run, done } = await launch(instance)
    const crash = new Error('Storage worker exited unexpectedly')
    if (stage === 'batch') {
      storage.applyBatch.mockRejectedValueOnce(crash)
      const batch = run.options.beforeAck!([])
      await expect(batch).rejects.toMatchObject({ uncertain: true })
      run.reject(new ScanCancelledError()) // The result of the pending write takes precedence.
      expect(storage.applyBatch).toHaveBeenCalledOnce()
    } else {
      storage.publishScan.mockRejectedValueOnce(crash)
      await root(run)
      await finish(instance, run)
    }
    expect(await done).toMatchObject({
      session: { status: 'failed' },
      failure: { code: 'SCAN_STORAGE_UNCERTAIN' }
    })
    expect(storage.discardBuildingScan).not.toHaveBeenCalled()
    expect(storage.publishScan).toHaveBeenCalledTimes(stage === 'batch' ? 0 : 1)
    expect(instance.getLatestCompleted()).toMatchObject({ id: earlier.scanId })
    expect(instance.getScanSnapshot().snapshot).toEqual(previousSnapshot)
    await expect(launch(instance)).rejects.toMatchObject({ code: 'SCAN_STORAGE_UNCERTAIN' })
    expect(storage.beginScan).toHaveBeenCalledTimes(2)
  }
)

test('blocks new scans when discard definitely fails and leaves a building scan unresolved', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const storage = storageMock()
  storage.discardBuildingScan.mockRejectedValueOnce(storageRejection())
  const instance = persistentManager(Promise.resolve(storage))
  const { run, done, scanId } = await launch(instance)
  instance.cancel()
  run.reject(new ScanCancelledError())
  expect(await done).toMatchObject({
    session: { status: 'failed' },
    failure: { code: 'SCAN_STORAGE_FAILED' }
  })
  await expect(launch(instance)).rejects.toMatchObject({ code: 'SCAN_STORAGE_FAILED' })
  expect(storage.beginScan).toHaveBeenCalledOnce()
  expect(storage.discardBuildingScan).toHaveBeenCalledExactlyOnceWith(scanId)
})

test('closes cancellation once publishing and holds terminal state and shutdown until commit', async () => {
  const storage = storageMock()
  const publication = Promise.withResolvers<void>()
  storage.publishScan.mockReturnValueOnce(publication.promise)
  const instance = persistentManager(Promise.resolve(storage))
  const { run, done, scanId } = await launch(instance)
  await root(run)
  await finish(instance, run)
  await vi.waitFor(() => expect(storage.publishScan).toHaveBeenCalledOnce())
  expect(instance.cancel()).toBe(false)
  expect(instance.getState()?.session.status).toBe('running')
  expect(instance.getLatestCompleted()).toBeNull()
  const disposing = vi.fn()
  const disposed = instance.dispose().then(disposing)
  await Promise.resolve()
  expect(disposing).not.toHaveBeenCalled()
  publication.resolve()
  expect((await done).session.status).toBe('completed')
  await disposed
  expect(storage.publishScan).toHaveBeenCalledWith(
    expect.objectContaining({ id: scanId }),
    'directory'
  )
  expect(storage.discardBuildingScan).not.toHaveBeenCalled()
})

async function begin(
  instance: ScanSessionManager,
  consume?: ScanEventConsumer
): Promise<{ done: Promise<ScanSessionState>; run: Run }> {
  const done = instance.start(rootPath, consume)
  await Promise.resolve()
  return { done, run: runs.at(-1)! }
}

function entry(run: Run, type: FileEntry['type'], sizeBytes: number | null = null): FileEntry {
  return {
    id: type,
    scanId: run.id,
    parentId: type === 'directory' ? null : 'directory',
    name: type,
    path: type === 'directory' ? run.path : resolve(run.path, type),
    type,
    sizeBytes,
    aggregatedSizeBytes: null,
    createdAt: null,
    modifiedAt: null
  }
}

async function root(run: Run): Promise<void> {
  await run.consume({ type: 'entry', entry: entry(run, 'directory') })
}

async function finish(instance: ScanSessionManager, run: Run): Promise<ScanSummaryEvent> {
  const state = instance.getState()!
  await run.consume({
    type: 'directory-finalized',
    entry: { ...entry(run, 'directory'), aggregatedSizeBytes: state.session.summary.totalBytes }
  })
  const summary: ScanSummaryEvent = {
    type: 'summary',
    scanId: run.id,
    rootEntryId: 'directory',
    summary: state.session.summary
  }
  await run.consume(summary)
  await run.options.onProgress!(instance.getState()!.progress)
  run.resolve(summary)
  return summary
}

test('creates unique running metadata immediately and completes only after worker settlement', async () => {
  const instance = manager()
  expect(instance.getState()).toBeNull()
  const states: ScanSessionState[] = []
  instance.subscribe((state) => {
    states.push(state)
  })
  const { done, run } = await begin(instance)
  const running = instance.getState()!
  expect(running.session).toMatchObject({
    id: run.id,
    rootPath,
    status: 'running',
    finishedAt: null
  })
  expect(run.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(new Date(running.session.startedAt).toISOString()).toBe(running.session.startedAt)
  await root(run)
  await run.consume({ type: 'entry', entry: entry(run, 'file', 25) })
  const summary: ScanSummaryEvent = {
    type: 'summary',
    scanId: run.id,
    rootEntryId: 'directory',
    summary: instance.getState()!.session.summary
  }
  await run.consume(summary)
  await run.options.onProgress!(instance.getState()!.progress)
  expect(instance.getState()!.session.status).toBe('running')
  expect(states.map((state) => state.session.status)).toEqual(['running', 'running'])
  run.resolve(summary)
  const completed = await done
  expect(completed.session.status).toBe('completed')
  expect(new Date(completed.session.finishedAt!).toISOString()).toBe(completed.session.finishedAt)
  expect(completed.session.summary).toEqual({
    fileCount: 1,
    directoryCount: 1,
    totalBytes: 25,
    errorCount: 0
  })
  expect(completed.progress).toMatchObject({
    scanId: run.id,
    processedBytes: 25,
    processedFileCount: 1,
    processedDirectoryCount: 1
  })
  expect(states.map((state) => state.session.status)).toEqual(['running', 'running', 'completed'])
})

test('completed partial scans count recoverable errors without retaining an error array or entries', async () => {
  const instance = manager()
  const { done, run } = await begin(instance)
  await root(run)
  await run.consume({ type: 'entry', entry: entry(run, 'file', 300) })
  await run.consume({
    type: 'error',
    error: { path: resolve(rootPath, 'private'), code: 'EACCES', message: 'Denied' }
  })
  await finish(instance, run)
  const state = await done
  expect(state.session.status).toBe('completed')
  expect(state.session.summary).toEqual({
    fileCount: 1,
    directoryCount: 1,
    totalBytes: 300,
    errorCount: 1
  })
  expect(state.failure).toBeNull()
  expect(Object.keys(state).sort()).toEqual(['failure', 'progress', 'session'])
})

test.each(['cancelled', 'failed'] as const)(
  'retains confirmed partial statistics on %s and waits for settlement',
  async (status) => {
    const instance = manager()
    const { done, run } = await begin(instance)
    await root(run)
    await run.consume({ type: 'entry', entry: entry(run, 'file', 75) })
    if (status === 'cancelled') {
      instance.cancel()
      instance.cancel()
      expect(run.options.signal!.aborted).toBe(true)
      expect(instance.getState()!.session.status).toBe('running')
      await expect(instance.start(rootPath)).rejects.toThrow('already active')
      run.reject(new ScanCancelledError())
    } else run.reject(Object.assign(new Error('Disk failed'), { code: 'EIO' }))
    const state = await done
    expect(state.session.status).toBe(status)
    expect(state.session.finishedAt).not.toBeNull()
    expect(state.session.summary).toEqual({
      fileCount: 1,
      directoryCount: 1,
      totalBytes: 75,
      errorCount: 0
    })
    expect(state.progress.processedBytes).toBe(75)
    expect(state.failure).toEqual(
      status === 'failed' ? { name: 'Error', message: 'Disk failed', code: 'EIO' } : null
    )
  }
)

test.each(['completed', 'cancelled', 'failed'] as const)(
  'isolates a new scan after %s and ignores late old callbacks',
  async (status) => {
    const instance = manager()
    const first = await begin(instance)
    await root(first.run)
    if (status === 'completed') await finish(instance, first.run)
    else {
      if (status === 'cancelled') instance.cancel()
      first.run.reject(status === 'cancelled' ? new ScanCancelledError() : new Error('Failed'))
    }
    const oldState = await first.done
    const second = await begin(instance)
    expect(second.run.id).not.toBe(first.run.id)
    const current = instance.getState()
    await first.run.consume({ type: 'entry', entry: entry(first.run, 'file', 999) })
    await first.run.options.onProgress!(oldState.progress)
    expect(instance.getState()).toEqual(current)
    expect(instance.getState()!.session.summary).toEqual({
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      errorCount: 0
    })
    await root(second.run)
    await finish(instance, second.run)
    expect((await second.done).session.status).toBe('completed')
  }
)

test('rejects concurrent starts without replacing the active session', async () => {
  const instance = manager()
  const { done, run } = await begin(instance)
  const before = instance.getState()
  await expect(instance.start(resolve('other'))).rejects.toThrow('already active')
  expect(instance.getState()).toEqual(before)
  expect(runScannerWorker).toHaveBeenCalledOnce()
  await root(run)
  await finish(instance, run)
  await done
})

test('protects getter, notification, event, and terminal snapshots from consumer mutation', async () => {
  const instance = manager()
  instance.subscribe((state) => {
    Object.assign(state.session.summary, { totalBytes: 999 })
    Object.assign(state.progress, { scanId: 'wrong' })
  })
  const seen: ScanSessionState[] = []
  instance.subscribe((state) => {
    seen.push(state)
  })
  const { done, run } = await begin(instance, (event) => {
    if (event.type === 'entry') Object.assign(event.entry, { sizeBytes: 999 })
  })
  Object.assign(instance.getState()!.session, { status: 'failed' })
  await root(run)
  await run.consume({ type: 'entry', entry: entry(run, 'file', 2) })
  await finish(instance, run)
  const terminal = await done
  Object.assign(terminal.session.summary, { totalBytes: 111 })
  expect(instance.getState()!.session.summary.totalBytes).toBe(2)
  expect(seen.at(-1)!.session.summary.totalBytes).toBe(2)
  expect(seen.at(-1)!.progress.scanId).toBe(run.id)
})

test('notifies only at creation, progress and termination; unsubscribe stops notifications', async () => {
  const instance = manager()
  const subscriber = vi.fn(() => undefined)
  const unsubscribe = instance.subscribe(subscriber)
  const { done, run } = await begin(instance)
  await root(run)
  for (let i = 0; i < 100; i++)
    await run.consume({ type: 'entry', entry: { ...entry(run, 'file', 1), id: String(i) } })
  expect(subscriber).toHaveBeenCalledOnce()
  await run.options.onProgress!(instance.getState()!.progress)
  expect(subscriber).toHaveBeenCalledTimes(2)
  unsubscribe()
  unsubscribe()
  await finish(instance, run)
  await done
  expect(subscriber).toHaveBeenCalledTimes(2)
})

test('removes failing subscribers and reports errors without corrupting the scan', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const instance = manager()
  const bad = vi.fn(() => {
    throw new Error('Observer failed')
  })
  instance.subscribe(bad)
  // JavaScript callers can bypass the synchronous subscriber type.
  instance.subscribe((async () => {
    throw new Error('Async observer failed')
  }) as unknown as ScanSessionSubscriber)
  const good = vi.fn(() => undefined)
  instance.subscribe(good)
  const { done, run } = await begin(instance)
  await root(run)
  await finish(instance, run)
  expect((await done).session.status).toBe('completed')
  expect(bad).toHaveBeenCalledOnce()
  expect(report).toHaveBeenCalled()
  expect(good).toHaveBeenCalledTimes(3)
})

test('callback failures produce failed sessions with only successfully consumed statistics', async () => {
  const instance = manager()
  const failure = new Error('Consumer failed')
  const { done, run } = await begin(instance, (event) => {
    if (event.type === 'entry' && event.entry.type === 'file') throw failure
  })
  await root(run)
  await expect(run.consume({ type: 'entry', entry: entry(run, 'file', 50) })).rejects.toBe(failure)
  run.reject(failure)
  const state = await done
  expect(state.session.status).toBe('failed')
  expect(state.session.summary).toEqual({
    fileCount: 0,
    directoryCount: 1,
    totalBytes: 0,
    errorCount: 0
  })
  expect(state.failure?.message).toBe('Consumer failed')
})

test('dispose cancels and awaits cleanup, clears observers, and rejects future work', async () => {
  const instance = manager()
  const subscriber = vi.fn(() => undefined)
  instance.subscribe(subscriber)
  const { done, run } = await begin(instance)
  const disposal = instance.dispose()
  expect(instance.dispose()).toBe(disposal)
  expect(run.options.signal!.aborted).toBe(true)
  expect(instance.getState()!.session.status).toBe('running')
  let disposed = false
  void disposal.then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  run.reject(new ScanCancelledError())
  await disposal
  expect((await done).session.status).toBe('cancelled')
  expect(subscriber).toHaveBeenCalledOnce()
  await expect(instance.start(rootPath)).rejects.toThrow('disposed')
  expect(() => instance.subscribe(() => undefined)).toThrow('disposed')
})

test('late completion of a pending consumer cannot overwrite a terminal or next session', async () => {
  const instance = manager()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = await begin(instance, () => pending)
  const event = first.run.consume({ type: 'entry', entry: entry(first.run, 'file', 500) })
  instance.cancel()
  first.run.reject(new ScanCancelledError())
  await first.done
  const second = await begin(instance)
  release()
  await event
  expect(instance.getState()!.session.summary.totalBytes).toBe(0)
  await root(second.run)
  await finish(instance, second.run)
  await second.done
})

test('validates roots and permits disposing an unused manager', async () => {
  const instance = manager()
  await expect(instance.start('')).rejects.toThrow('Root path')
  expect(instance.getState()).toBeNull()
  await instance.dispose()
  expect(runScannerWorker).not.toHaveBeenCalled()
})

test('retains one isolated completed summary through later attempts and resets on recreation', async () => {
  const instance = manager()
  expect(instance.getLatestCompleted()).toBeNull()
  const first = await begin(instance)
  await root(first.run)
  await first.run.consume({ type: 'entry', entry: entry(first.run, 'file', 300) })
  await first.run.consume({
    type: 'error',
    error: { path: rootPath, code: 'EACCES', message: 'Denied' }
  })
  expect(instance.getLatestCompleted()).toBeNull()
  await finish(instance, first.run)
  const completed = await first.done
  const summary = instance.getLatestCompleted()!
  expect(summary).toEqual({
    id: first.run.id,
    path: rootPath,
    completedAt: completed.session.finishedAt,
    totalBytes: 300,
    fileCount: 1,
    errorCount: 1
  })
  Object.assign(instance.getLatestCompleted()!, { totalBytes: 999 })
  for (const status of ['cancelled', 'failed']) {
    const next = await begin(instance)
    expect(instance.getLatestCompleted()).toEqual(summary)
    if (status === 'cancelled') instance.cancel()
    next.run.reject(status === 'cancelled' ? new ScanCancelledError() : new Error('Failed'))
    await next.done
    expect(instance.getLatestCompleted()).toEqual(summary)
  }
  const next = await begin(instance)
  await root(next.run)
  await finish(instance, next.run)
  await next.done
  expect(instance.getLatestCompleted()!.id).toBe(next.run.id)
  expect(manager().getLatestCompleted()).toBeNull()
})

test('publishes storage only after settlement, preserves it across attempts, and expires old references', async () => {
  const instance = manager()
  expect(instance.getScanSnapshot()).toEqual({ snapshot: null, unavailable: null })
  const first = await begin(instance)
  await root(first.run)
  await first.run.consume({ type: 'entry', entry: entry(first.run, 'file', 300) })
  await first.run.consume({
    type: 'error',
    error: { path: rootPath, code: 'EACCES', message: 'Denied' }
  })
  // Even final aggregation and summary do not publish before worker exit.
  const settle = first.run.resolve
  first.run.resolve = () => {}
  const result = await finish(instance, first.run)
  expect(instance.getScanSnapshot().snapshot).toBeNull()
  expect(() => instance.getScanEntry({ scanId: first.run.id, entryId: 'directory' })).toThrow(
    'no available snapshot'
  )
  settle(result)
  await first.done
  const available = instance.getScanSnapshot()
  expect(available.snapshot).toMatchObject({
    root: { aggregatedSizeBytes: 300 },
    incomplete: true,
    summary: { errorCount: 1 }
  })
  const reference = { scanId: first.run.id, entryId: 'directory' }
  expect(instance.listScanDirectory({ ...reference, offset: 0, limit: 10 }).entries).toEqual([
    entry(first.run, 'file', 300)
  ])
  expect(instance.getScanDirectoryTreemap(reference).entries).toEqual([
    entry(first.run, 'file', 300)
  ])
  for (const outcome of ['cancelled', 'failed']) {
    const next = await begin(instance)
    await root(next.run)
    expect(instance.getScanSnapshot()).toEqual(available)
    if (outcome === 'cancelled') instance.cancel()
    next.run.reject(
      outcome === 'cancelled' ? new ScanCancelledError() : new Error('Worker failed after entries')
    )
    await next.done
    expect(instance.getScanSnapshot()).toEqual(available)
    expect(instance.getScanEntry(reference).aggregatedSizeBytes).toBe(300)
  }
  const next = await begin(instance)
  await root(next.run)
  await finish(instance, next.run)
  await next.done
  expect(instance.getScanSnapshot().snapshot!.entries.scanId).toBe(next.run.id)
  expect(() => instance.getScanEntry(reference)).toThrow('no longer available')
  expect(() => instance.getScanDirectoryTreemap(reference)).toThrow('no longer available')
  expect(() => instance.getScanEntry({ scanId: next.run.id, entryId: 'file' })).toThrow(
    'does not exist'
  )
  await instance.dispose()
  expect(instance.getScanSnapshot()).toEqual({ snapshot: null, unavailable: null })
  expect(() => instance.getScanEntry({ scanId: next.run.id, entryId: 'directory' })).toThrow(
    'no available snapshot'
  )
})

test('retention limits preserve previous entries while new statistics finish successfully', async () => {
  const instance = new ScanSessionManager({ maxEntries: 1, maxEstimatedBytes: 1_000_000 })
  managers.push(instance)
  const first = await begin(instance)
  await root(first.run)
  await finish(instance, first.run)
  await first.done
  const previous = instance.getScanSnapshot().snapshot
  const next = await begin(instance)
  await root(next.run)
  await next.run.consume({ type: 'entry', entry: entry(next.run, 'file', 300) })
  await finish(instance, next.run)
  const terminal = await next.done
  expect(terminal.session).toMatchObject({
    status: 'completed',
    summary: { totalBytes: 300, fileCount: 1 }
  })
  expect(instance.getLatestCompleted()!.id).toBe(next.run.id)
  expect(instance.getScanSnapshot()).toEqual({
    snapshot: previous,
    unavailable: { scanId: next.run.id, reason: 'limit-exceeded' }
  })
  expect(
    instance.getScanDirectoryTreemap({ scanId: first.run.id, entryId: 'directory' })
  ).toMatchObject({ scanId: first.run.id, totalCount: 0 })
  expect(() =>
    instance.getScanDirectoryTreemap({ scanId: next.run.id, entryId: 'directory' })
  ).toThrow('no available snapshot')
  expect(() => instance.getScanEntry({ scanId: next.run.id, entryId: 'directory' })).toThrow(
    'no available snapshot'
  )
  // A subsequent retainable completion clears the diagnostic and replaces the old snapshot.
  const last = await begin(instance)
  await root(last.run)
  await finish(instance, last.run)
  await last.done
  expect(instance.getScanSnapshot().unavailable).toBeNull()
  expect(instance.getScanSnapshot().snapshot!.entries.scanId).toBe(last.run.id)
})

test('invalid storage cannot replace published entries or invalidate otherwise valid scan statistics', async () => {
  const instance = manager()
  const first = await begin(instance)
  await root(first.run)
  await finish(instance, first.run)
  await first.done
  const previous = instance.getScanSnapshot().snapshot
  const next = await begin(instance)
  await root(next.run)
  await next.run.consume({
    type: 'entry',
    entry: { ...entry(next.run, 'file', 10), parentId: 'missing' }
  })
  await finish(instance, next.run)
  expect((await next.done).session.status).toBe('completed')
  expect(instance.getScanSnapshot()).toEqual({
    snapshot: previous,
    unavailable: { scanId: next.run.id, reason: 'invalid-data' }
  })
})

test('shutdown discards building and published entries even with a pending consumer', async () => {
  const instance = manager()
  const first = await begin(instance)
  await root(first.run)
  await finish(instance, first.run)
  await first.done
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = await begin(instance, () => pending)
  const callback = root(next.run)
  const disposal = instance.dispose()
  expect(instance.getScanSnapshot().snapshot).toBeNull()
  next.run.reject(new ScanCancelledError())
  await disposal
  release()
  await callback
  expect(instance.getScanSnapshot()).toEqual({ snapshot: null, unavailable: null })
})
