// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
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
