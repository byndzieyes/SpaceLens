// @vitest-environment node

import { once } from 'node:events'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { InsightsQueryService } from '../src/main/insights/queryService'
import { SCANNER_BATCH_SIZE } from '../src/main/scanner/workerProtocol'
import {
  MAX_QUEUED_EXPLORER_READS,
  ScanStorageCoordinator,
  StorageUnavailableError
} from '../src/main/storage/coordinator'
import { ScanDatabase } from '../src/main/storage/database'
import type {
  BuildingScan,
  CompletedScan,
  StorageBatchOperation
} from '../src/main/storage/payloads'
import {
  STORAGE_REQUEST_TIMEOUT_MS,
  STORAGE_SHUTDOWN_TIMEOUT_MS,
  StorageWorkerClient
} from '../src/main/storage/workerClient'
import type { createStorageWorkerClient } from '../src/main/storage/workerRunner'
import type { StorageRequest } from '../src/main/storage/workerProtocol'
import type { FileEntry, ScanSession } from '../src/shared/scan'

const require = createRequire(import.meta.url)
const clients = new Set<StorageWorkerClient>()
const workers = new Set<Worker>()
let suitePath: string
let databasePath: string
let workerPath: string
let createBundledClient: typeof createStorageWorkerClient

const rootPath = resolve('storage-fixture')
const timestamp = '2026-11-20T12:30:45.000+02:00'
const scan: ScanSession = {
  id: 'scan-a',
  rootPath,
  startedAt: timestamp,
  finishedAt: null,
  status: 'running',
  summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
}

const root: FileEntry = {
  id: 'root',
  scanId: scan.id,
  parentId: null,
  name: 'storage-fixture',
  path: rootPath,
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: null,
  createdAt: null,
  modifiedAt: timestamp
}

const fileName = "Фото 📁 'quotes' \ud800.txt"
const file: FileEntry = {
  id: 'file',
  scanId: scan.id,
  parentId: root.id,
  name: fileName,
  path: join(rootPath, fileName),
  type: 'file',
  sizeBytes: 0,
  aggregatedSizeBytes: null,
  createdAt: timestamp,
  modifiedAt: null
}

beforeAll(async () => {
  suitePath = await mkdtemp(join(tmpdir(), 'spacelens-storage-worker-'))
  const previousMode = process.env.NODE_ENV_ELECTRON_VITE
  try {
    process.env.NODE_ENV_ELECTRON_VITE = 'production'
    const { config } = await resolveConfig(
      { root: process.cwd(), mode: 'production', logLevel: 'silent', build: { outDir: suitePath } },
      'build',
      'production'
    )
    if (!config?.main) throw new Error('Missing Electron Main build configuration.')
    await build(config.main)
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV_ELECTRON_VITE
    else process.env.NODE_ENV_ELECTRON_VITE = previousMode
  }

  const main = join(suitePath, 'main')
  const files = await readdir(main, { recursive: true })
  const worker = files.find((file) => /^storage\.worker-.*\.js$/.test(basename(file)))
  if (!worker) throw new Error('Missing generated storage worker chunk.')
  workerPath = join(main, worker)
  const runner = require(join(main, 'storageWorkerRunner.js')) as {
    createStorageWorkerClient: typeof createStorageWorkerClient
  }
  createBundledClient = runner.createStorageWorkerClient
}, 60_000)

beforeEach(async () => {
  databasePath = join(await mkdtemp(join(suitePath, 'db-')), 'scans.sqlite')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.allSettled([...clients].map((client) => client.dispose()))
  await Promise.all([...workers].map((worker) => worker.terminate()))
  clients.clear()
  workers.clear()
})

afterAll(async () => {
  if (!suitePath) return
  const target = resolve(suitePath)
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('spacelens-storage-worker-')
  ) {
    throw new Error('Refusing to remove a path outside temporary storage worker fixtures.')
  }
  await rm(target, { recursive: true, force: true })
})

function bundled(): StorageWorkerClient {
  const client = createBundledClient()
  clients.add(client)
  return client
}

function start(script?: string): Worker {
  const worker = new Worker(script ?? workerPath, { eval: script !== undefined })
  workers.add(worker)
  return worker
}

function wrap(worker: Worker): StorageWorkerClient {
  const client = new StorageWorkerClient(worker)
  clients.add(client)
  return client
}

function expectReleased(worker: Worker): void {
  expect(worker.threadId).toBe(-1)
  for (const event of ['message', 'messageerror', 'error', 'exit']) {
    expect(worker.listenerCount(event)).toBe(0)
  }
}

test('starts the bundled worker explicitly and opens only after initialization', async () => {
  const client = bundled()
  await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(client.getScan(scan.id)).rejects.toThrow('Storage worker is not initialized.')

  await client.initialize(databasePath)
  await expect(stat(databasePath)).resolves.toBeDefined()
  await expect(client.initialize(databasePath)).rejects.toThrow('state ready')
  await expect(client.getScan(scan.id)).resolves.toBeNull()
  await expect(client.getEntry(scan.id, root.id)).resolves.toBeNull()
  await expect(client.dispose()).resolves.toBeUndefined()
})

test('round-trips scan-scoped entries, large safe integers, zero, nulls, and Unicode', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  const maximum = Number.MAX_SAFE_INTEGER
  const completed: ScanSession = {
    ...scan,
    id: 'scan-b',
    status: 'completed',
    finishedAt: timestamp,
    rootPath: `${rootPath} 資料 \ud800`,
    summary: { fileCount: 1, directoryCount: 1, totalBytes: maximum, errorCount: 2 }
  }
  const secondRoot = {
    ...root,
    scanId: completed.id,
    path: completed.rootPath,
    aggregatedSizeBytes: maximum
  }
  const secondFile = {
    ...file,
    scanId: completed.id,
    path: join(completed.rootPath, fileName),
    sizeBytes: maximum
  }
  await client.insertScan(scan)
  await client.insertScan(completed)
  for (const entry of [root, file, secondRoot, secondFile]) await client.insertEntry(entry)

  await expect(client.getScan(scan.id)).resolves.toEqual(scan)
  await expect(client.getScan(completed.id)).resolves.toEqual(completed)
  await expect(client.getEntry(scan.id, root.id)).resolves.toEqual(root)
  await expect(client.getEntry(completed.id, root.id)).resolves.toEqual(secondRoot)
  await expect(client.getEntry(scan.id, file.id)).resolves.toEqual(file)
  await expect(client.getEntry(completed.id, file.id)).resolves.toEqual(secondFile)
})

test('accepts one in-flight request, so callers await writes before reading', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  const inserted = client.insertScan(scan)
  await expect(client.getScan(scan.id)).rejects.toThrow('already in flight')
  await inserted
  await expect(client.getScan(scan.id)).resolves.toEqual(scan)
})

test('acknowledges a mixed batch only after commit and reopens the exact values', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.insertScan(scan)
  const directory = { ...root, type: 'directory' as const, aggregatedSizeBytes: 0 }
  await client.applyBatch(scan.id, [
    { type: 'entry', entry: root },
    { type: 'entry', entry: file },
    { type: 'directory-finalized', entry: directory }
  ])

  // A second, read-only connection sees the committed changes while the worker is still open.
  const observer = new DatabaseSync(databasePath, { readOnly: true })
  try {
    expect(
      observer.prepare('SELECT id, aggregated_size_bytes FROM entries ORDER BY id').all()
    ).toEqual([
      { id: 'file', aggregated_size_bytes: null },
      { id: 'root', aggregated_size_bytes: 0 }
    ])
  } finally {
    observer.close()
  }
  await client.dispose()

  const reopened = bundled()
  await reopened.initialize(databasePath)
  await expect(reopened.getEntry(scan.id, root.id)).resolves.toEqual(directory)
  await expect(reopened.getEntry(scan.id, file.id)).resolves.toEqual(file)
})

test('propagates a batch constraint error, rolls back its writes, and accepts a later batch', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.insertScan(scan)
  await client.applyBatch(scan.id, [{ type: 'entry', entry: root }])
  await expect(
    client.applyBatch(scan.id, [
      { type: 'entry', entry: file },
      { type: 'entry', entry: { ...file, id: 'orphan', parentId: 'missing' } }
    ])
  ).rejects.toMatchObject({
    message: 'FOREIGN KEY constraint failed',
    code: 'ERR_SQLITE_ERROR',
    sqliteCode: 787
  })
  await expect(client.getEntry(scan.id, file.id)).resolves.toBeNull()
  await expect(client.getEntry(scan.id, root.id)).resolves.toEqual(root)

  const directory = { ...root, type: 'directory' as const, aggregatedSizeBytes: 0 }
  await expect(
    client.applyBatch(scan.id, [
      { type: 'entry', entry: file },
      { type: 'directory-finalized', entry: { ...directory, id: 'missing' } }
    ])
  ).rejects.toMatchObject({ message: 'Cannot finalize missing entry missing.', code: null })
  await expect(client.getEntry(scan.id, file.id)).resolves.toBeNull()
  await client.applyBatch(scan.id, [
    { type: 'entry', entry: file },
    { type: 'directory-finalized', entry: directory }
  ])
  await expect(client.getEntry(scan.id, root.id)).resolves.toEqual(directory)
})

test('reports malformed, mixed-scan, and oversized batch requests as structured errors', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.insertScan(scan)
  const discovery = { type: 'entry', entry: root } satisfies StorageBatchOperation
  await expect(
    client.applyBatch(scan.id, [discovery, { type: 'entry', entry: { ...file, scanId: 'other' } }])
  ).rejects.toMatchObject({
    name: 'TypeError',
    message: expect.stringContaining('different scan'),
    code: null
  })
  await expect(
    client.applyBatch(
      scan.id,
      Array.from({ length: SCANNER_BATCH_SIZE + 1 }, () => discovery)
    )
  ).rejects.toMatchObject({
    name: 'RangeError',
    message: expect.stringContaining('at most'),
    code: null
  })
  await expect(
    client.applyBatch(scan.id, [
      discovery,
      { type: 'entry', entry: { ...file, sizeBytes: Number.MAX_SAFE_INTEGER + 1 } }
    ])
  ).rejects.toMatchObject({
    name: 'TypeError',
    message: expect.stringContaining('operation 2'),
    code: null
  })
  await expect(client.getEntry(scan.id, root.id)).resolves.toBeNull()
})

test('keeps batches single-in-flight and stops accepting them once disposal starts', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.insertScan(scan)
  const operations = [{ type: 'entry', entry: root }] satisfies StorageBatchOperation[]
  const committed = client.applyBatch(scan.id, operations)
  await expect(client.applyBatch(scan.id, operations)).rejects.toThrow('already in flight')
  const closing = client.dispose()
  await expect(client.applyBatch(scan.id, [])).rejects.toThrow('closing or closed')
  await committed
  await closing
})

function lifecycleScan(id: string): BuildingScan {
  return { ...scan, id, status: 'running', finishedAt: null }
}

function readyMetadata(pending: BuildingScan): CompletedScan {
  return {
    ...pending,
    status: 'completed',
    finishedAt: '2026-11-20T12:00:00.000Z',
    summary: { fileCount: 1, directoryCount: 1, totalBytes: 0, errorCount: 0 }
  }
}

async function preparePublication(
  client: StorageWorkerClient,
  pending: BuildingScan
): Promise<CompletedScan> {
  await client.beginScan(pending)
  await client.applyBatch(pending.id, [
    { type: 'entry', entry: { ...root, scanId: pending.id } },
    { type: 'entry', entry: { ...file, scanId: pending.id } },
    {
      type: 'directory-finalized',
      entry: { ...root, scanId: pending.id, type: 'directory', aggregatedSizeBytes: 0 }
    }
  ])
  return readyMetadata(pending)
}

test('coordinates a real Worker after startup and prioritizes publication over Explorer and Insights reads', async () => {
  const client = bundled()
  const ready = Promise.withResolvers<StorageWorkerClient>()
  const storage = new ScanStorageCoordinator(ready.promise)
  const insights = new InsightsQueryService(storage)
  const { signal } = new AbortController()
  const release = Promise.withResolvers<void>()
  const received = Promise.withResolvers<void>()
  const direct = client.getInsightsSizeDistribution.bind(client)
  const metadata = vi
    .spyOn(client, 'getInsightsSizeDistribution')
    .mockImplementationOnce(async (scanId) => {
      const snapshot = await direct(scanId)
      received.resolve()
      await release.promise
      return snapshot
    })
  const oldRead = insights.getSizeDistribution({ scanId: 'previous' }, signal)
  try {
    await client.initialize(databasePath)
    await client.recoverStorage()
    const old = await preparePublication(client, lifecycleScan('previous'))
    await client.publishScan(old, root.id)
    const next = await preparePublication(client, lifecycleScan('next'))
    expect(metadata).not.toHaveBeenCalled()
    ready.resolve(client)
    await received.promise

    const oldEntry = expect(
      storage.read(signal, (db) => db.getScanEntry({ scanId: old.id, entryId: file.id }))
    ).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' })
    const nextSnapshot = storage.read(signal, (db) => db.getScanSnapshot())
    const expiredSummary = expect(
      insights.getSummary({ scanId: old.id }, signal)
    ).rejects.toMatchObject({
      code: 'SNAPSHOT_EXPIRED'
    })
    const nextSummary = insights.getSummary({ scanId: next.id }, signal)
    const nextCategories = insights.getCategories({ scanId: next.id }, signal)
    const distribution = insights.getSizeDistribution({ scanId: next.id }, signal)
    const expiredExtensions = expect(
      insights.listExtensions({ scanId: old.id }, signal)
    ).rejects.toMatchObject({
      code: 'SNAPSHOT_EXPIRED'
    })
    const nextExtensions = insights.listExtensions({ scanId: next.id }, signal)
    const oldRanking = expect(
      insights.listLargest({ scanId: old.id }, 'file', signal)
    ).rejects.toMatchObject({
      code: 'SNAPSHOT_EXPIRED'
    })
    const nextRanking = insights.listLargest({ scanId: next.id }, 'file', signal)
    const page = storage.read(signal, (db) =>
      db.listScanDirectory({ scanId: next.id, entryId: root.id, offset: 0, limit: 100 })
    )
    const publish = storage.publishScan(next, root.id)
    release.resolve()
    expect((await oldRead).scanId).toBe(old.id)
    await publish
    await oldEntry
    await expiredSummary
    await expiredExtensions
    await oldRanking
    expect((await nextSnapshot).snapshot?.entries.scanId).toBe(next.id)
    expect(await nextSummary).toMatchObject({ scanId: next.id, summary: next.summary })
    expect(await nextCategories).toMatchObject({ scanId: next.id })
    expect(await distribution).toMatchObject({
      scanId: next.id,
      knownSizeCount: 1,
      totals: { fileCount: 1, knownBytes: 0 }
    })
    expect(await nextExtensions).toMatchObject({
      scanId: next.id,
      extensions: [{ extension: 'txt' }]
    })
    expect(await nextRanking).toMatchObject({
      scanId: next.id,
      entries: [{ id: file.id, parentId: root.id }]
    })
    expect(await page).toMatchObject({ scanId: next.id, totalCount: 1, nextOffset: null })
  } finally {
    storage.stopReads()
    release.resolve()
    await oldRead.catch(() => {})
  }
})

test('queues rankings and Explorer reads alongside a real Scanner batch for a replacement scan', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.recoverStorage()
  const old = await preparePublication(client, lifecycleScan('previous'))
  await client.publishScan(old, root.id)
  const next = lifecycleScan('replacement')
  await client.beginScan(next)
  const storage = new ScanStorageCoordinator(Promise.resolve(client))
  const insights = new InsightsQueryService(storage)
  const { signal } = new AbortController()
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const apply = client.applyBatch.bind(client)
  vi.spyOn(client, 'applyBatch').mockImplementationOnce(async (scanId, operations) => {
    await apply(scanId, operations)
    received.resolve()
    await release.promise
  })
  const write = storage.applyBatch(next.id, [
    { type: 'entry', entry: { ...root, scanId: next.id } }
  ])
  try {
    await received.promise
    const sent = vi.spyOn(client, 'listInsightsLargestFiles')
    const ranking = insights.listLargest({ scanId: old.id }, 'file', signal)
    const distribution = insights.getSizeDistribution({ scanId: old.id }, signal)
    const current = storage.read(signal, (db) =>
      db.getScanEntry({ scanId: old.id, entryId: file.id })
    )
    const building = expect(
      insights.listLargest({ scanId: next.id }, 'directory', signal)
    ).rejects.toMatchObject({
      code: 'SNAPSHOT_UNAVAILABLE'
    })
    expect(sent).not.toHaveBeenCalled()
    release.resolve()
    await write
    expect(await ranking).toMatchObject({ scanId: old.id, entries: [{ id: file.id, bytes: 0 }] })
    const observed = await distribution
    expect(observed).toMatchObject({ scanId: old.id, knownSizeCount: 1, totals: { knownBytes: 0 } })
    expect(observed.buckets[0]).toEqual({ id: 'empty', fileCount: 1, knownBytes: 0 })
    expect(await current).toMatchObject({ scanId: old.id, id: file.id })
    await building
    await storage.discardBuildingScan(next.id)
    expect(await insights.listLargest({ scanId: old.id }, 'file', signal)).toEqual(await ranking)
  } finally {
    release.resolve()
    storage.stopReads()
    await write.catch(() => {})
  }
})

test('bounds waits during startup, drops abandoned renderer work and allows a new request in its place', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const ready = Promise.withResolvers<StorageWorkerClient>()
  const storage = new ScanStorageCoordinator(ready.promise)
  const insights = new InsightsQueryService(storage)
  const abandoned = new AbortController()
  const live = new AbortController()
  const query = vi.fn((db: Pick<StorageWorkerClient, 'getScanSnapshot'>) => db.getScanSnapshot())
  const waiting = Array.from({ length: MAX_QUEUED_EXPLORER_READS }, (_, index) =>
    storage.read(index === 0 ? abandoned.signal : live.signal, query)
  )
  const results = Promise.allSettled(waiting)
  await expect(storage.read(live.signal, query)).rejects.toThrow('busy')
  const request = { scanId: 'previous' }
  await expect(insights.getSummary(request, live.signal)).rejects.toThrow('busy')
  await expect(insights.getSizeDistribution(request, live.signal)).rejects.toThrow('busy')
  abandoned.abort()
  const replacement = expect(insights.getSummary(request, live.signal)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(STORAGE_REQUEST_TIMEOUT_MS)
  await replacement
  const [first, ...others] = await results
  expect(first).toMatchObject({
    status: 'rejected',
    reason: { message: expect.stringContaining('no longer active') }
  })
  expect(others).toHaveLength(MAX_QUEUED_EXPLORER_READS - 1)
  expect(
    others.every((one) => one.status === 'rejected' && one.reason.message.includes('timed out'))
  ).toBe(true)
  expect(query).not.toHaveBeenCalled()
})

test('rejects active and queued Explorer callers on shutdown and lets scanner cleanup finish', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await preparePublication(client, lifecycleScan('interrupted'))
  const storage = new ScanStorageCoordinator(Promise.resolve(client))
  const release =
    Promise.withResolvers<Awaited<ReturnType<StorageWorkerClient['getScanSnapshot']>>>()
  const received = Promise.withResolvers<void>()
  vi.spyOn(client, 'getScanSnapshot').mockImplementationOnce(() => {
    received.resolve()
    return release.promise
  })
  const { signal } = new AbortController()
  const active = expect(storage.read(signal, (db) => db.getScanSnapshot())).rejects.toThrow(
    'shutting down'
  )
  await received.promise
  const queued = expect(
    storage.read(signal, (db) =>
      db.getScanDirectoryTreemap({ scanId: 'interrupted', entryId: root.id })
    )
  ).rejects.toThrow('shutting down')
  const insights = new InsightsQueryService(storage)
  const queuedSummary = expect(
    insights.getSummary({ scanId: 'interrupted' }, signal)
  ).rejects.toThrow('shutting down')
  const queuedDistribution = expect(
    insights.getSizeDistribution({ scanId: 'interrupted' }, signal)
  ).rejects.toThrow('shutting down')
  storage.stopReads()
  await Promise.all([active, queued, queuedSummary, queuedDistribution])
  const cleanup = storage.discardBuildingScan('interrupted')
  release.resolve({ snapshot: null, unavailable: null })
  await cleanup
  await expect(client.getScan('interrupted')).resolves.toBeNull()
  await expect(storage.read(signal, (db) => db.getScanSnapshot())).rejects.toBeInstanceOf(
    StorageUnavailableError
  )
  await client.dispose()
})

test('fails all queued work on Worker exit and does not dispatch a waiting write', async () => {
  const worker = start(`
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', ({ requestId, operation }) => {
      if (operation === 'initialize') parentPort.postMessage({ requestId, ok: true, result: null })
      else process.exit(7)
    })
  `)
  const sent = vi.spyOn(worker, 'postMessage')
  const client = wrap(worker)
  await client.initialize(databasePath)
  const storage = new ScanStorageCoordinator(Promise.resolve(client))
  const { signal } = new AbortController()
  const first = expect(
    storage.read(signal, (db) =>
      db.getScanDirectoryTreemap({ scanId: 'previous', entryId: root.id })
    )
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  await Promise.resolve()
  const second = expect(storage.read(signal, (db) => db.getScanSnapshot())).rejects.toBeInstanceOf(
    StorageUnavailableError
  )
  const insights = new InsightsQueryService(storage)
  const summary = expect(
    insights.getSummary({ scanId: 'previous' }, signal)
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  const distribution = expect(
    insights.getSizeDistribution({ scanId: 'previous' }, signal)
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  const write = expect(storage.beginScan(lifecycleScan('unsent'))).rejects.toBeInstanceOf(
    StorageUnavailableError
  )
  await Promise.all([first, second, write, summary, distribution])
  expect(sent.mock.calls.map(([request]) => (request as StorageRequest).operation)).toEqual([
    'initialize',
    'getScanDirectoryTreemap'
  ])
  await expect(client.dispose()).rejects.toThrow('exited unexpectedly')
  expectReleased(worker)
})

test('reads exact Insights summaries from published rows across cancellation, recovery and replacement', async () => {
  const client = bundled()
  const { signal } = new AbortController()
  await client.initialize(databasePath)
  await client.recoverStorage()
  const storage = new ScanStorageCoordinator(Promise.resolve(client))
  const insights = new InsightsQueryService(storage)

  const previous = { ...lifecycleScan('previous'), rootPath: join(rootPath, "диск '📁'") }
  const request = { scanId: previous.id }
  await expect(insights.getSizeDistribution(request, signal)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await expect(insights.getSummary(request, signal)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await expect(insights.getCategories(request, signal)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await expect(insights.listLargest(request, 'file', signal)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await storage.beginScan(previous)
  await expect(insights.getSummary(request, signal)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await expect(client.requirePublishedScan('wrong/id')).rejects.toMatchObject({
    code: 'INVALID_REQUEST'
  })
  await expect(
    client.listInsightsExtensions({ ...request, offset: 0, limit: 101 })
  ).rejects.toMatchObject({
    code: 'INVALID_REQUEST'
  })

  const directory = {
    ...root,
    scanId: previous.id,
    path: previous.rootPath,
    type: 'directory' as const
  }
  const nested = {
    ...directory,
    id: 'nested',
    parentId: directory.id,
    name: 'nested',
    path: join(directory.path, 'nested')
  }
  const known = {
    ...file,
    scanId: previous.id,
    parentId: nested.id,
    path: join(nested.path, fileName),
    sizeBytes: Number.MAX_SAFE_INTEGER
  }
  const unknown = {
    ...known,
    id: 'unknown-size',
    parentId: directory.id,
    path: join(previous.rootPath, 'unknown-size.txt'),
    name: 'unknown-size.txt',
    sizeBytes: null,
    createdAt: null
  }
  const completed: CompletedScan = {
    ...readyMetadata(previous),
    summary: { totalBytes: Number.MAX_SAFE_INTEGER, fileCount: 2, directoryCount: 2, errorCount: 2 }
  }
  await storage.applyBatch(previous.id, [
    { type: 'entry', entry: directory },
    { type: 'entry', entry: nested },
    { type: 'entry', entry: known },
    { type: 'entry', entry: unknown },
    {
      type: 'directory-finalized',
      entry: { ...nested, aggregatedSizeBytes: Number.MAX_SAFE_INTEGER }
    },
    {
      type: 'directory-finalized',
      entry: { ...directory, aggregatedSizeBytes: completed.summary.totalBytes }
    }
  ])
  await storage.publishScan(completed, directory.id)
  const expected = {
    scanId: previous.id,
    rootPath: previous.rootPath,
    completedAt: completed.finishedAt,
    summary: completed.summary,
    incomplete: true
  }
  const interrupted = lifecycleScan('interrupted')
  const totals = { fileCount: 2, unknownSizeCount: 1, knownBytes: Number.MAX_SAFE_INTEGER }
  const expectedCategories = {
    scanId: previous.id,
    incomplete: true,
    totals,
    categories: [{ category: 'documents', ...totals }]
  }
  const expectedExtensions = {
    scanId: previous.id,
    incomplete: true,
    totals,
    totalCount: 1,
    nextOffset: null,
    extensions: [{ extension: 'txt', category: 'documents', ...totals }]
  }
  await storage.beginScan(interrupted)
  const previousDistribution = await insights.getSizeDistribution(request, signal)
  expect(previousDistribution).toMatchObject({
    scanId: previous.id,
    incomplete: true,
    knownSizeCount: 1,
    totals
  })
  expect(previousDistribution.buckets).toHaveLength(6)
  expect(previousDistribution.buckets.at(-1)).toEqual({
    id: 'veryLarge',
    fileCount: 1,
    knownBytes: Number.MAX_SAFE_INTEGER
  })
  await expect(
    insights.getSizeDistribution({ scanId: interrupted.id }, signal)
  ).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  const previousFiles = await insights.listLargest(request, 'file', signal)
  const previousDirectories = await insights.listLargest(request, 'directory', signal)
  expect(previousFiles).toMatchObject({
    incomplete: true,
    totalCount: 2,
    entries: [
      { id: known.id, parentId: nested.id, path: known.path, bytes: Number.MAX_SAFE_INTEGER },
      { id: unknown.id, bytes: null }
    ]
  })
  expect(previousDirectories).toMatchObject({
    totalCount: 1,
    entries: [{ id: nested.id, parentId: directory.id, bytes: Number.MAX_SAFE_INTEGER }]
  })
  await expect(
    insights.listLargest({ scanId: interrupted.id }, 'directory', signal)
  ).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await expect(insights.getCategories(request, signal)).resolves.toEqual(expectedCategories)
  await expect(insights.listExtensions({ scanId: interrupted.id }, signal)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await expect(insights.getSummary(request, signal)).resolves.toEqual(expected)
  await expect(insights.getSummary({ scanId: interrupted.id }, signal)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await storage.discardBuildingScan(interrupted.id)
  await expect(insights.getSizeDistribution(request, signal)).resolves.toEqual(previousDistribution)
  await expect(insights.listLargest(request, 'file', signal)).resolves.toEqual(previousFiles)
  await expect(insights.listExtensions(request, signal)).resolves.toEqual(expectedExtensions)
  await expect(insights.getSummary(request, signal)).resolves.toEqual(expected)
  await expect(client.getScan(previous.id)).resolves.toEqual(completed)
  await expect(
    storage.read(signal, (db) => db.getScanEntry({ scanId: previous.id, entryId: unknown.id }))
  ).resolves.toEqual(unknown)
  await storage.beginScan(interrupted)
  await expect(storage.publishScan(readyMetadata(interrupted), root.id)).rejects.toThrow(
    'root directory'
  )
  await expect(insights.getSizeDistribution(request, signal)).resolves.toEqual(previousDistribution)
  await expect(insights.getSummary(request, signal)).resolves.toEqual(expected)
  storage.stopReads()
  await client.dispose()

  const reopened = bundled()
  const ready = Promise.withResolvers<StorageWorkerClient>()
  const restoredStorage = new ScanStorageCoordinator(ready.promise)
  const restoredInsights = new InsightsQueryService(restoredStorage)
  const duringStartup = restoredInsights.getSummary(request, signal)
  try {
    await reopened.initialize(databasePath)
    await reopened.recoverStorage()
    ready.resolve(reopened)
    await expect(duringStartup).resolves.toEqual(expected)
    await expect(restoredInsights.getSizeDistribution(request, signal)).resolves.toEqual(
      previousDistribution
    )
    await expect(restoredInsights.listLargest(request, 'file', signal)).resolves.toEqual(
      previousFiles
    )
    await expect(restoredInsights.listLargest(request, 'directory', signal)).resolves.toEqual(
      previousDirectories
    )
    await expect(restoredInsights.getCategories(request, signal)).resolves.toEqual(
      expectedCategories
    )
    await expect(restoredInsights.listExtensions(request, signal)).resolves.toEqual(
      expectedExtensions
    )
    await expect(reopened.getScan(interrupted.id)).resolves.toBeNull()

    const replacement = lifecycleScan('replacement')
    const emptyRoot = { ...root, scanId: replacement.id, type: 'directory' as const }
    const empty = {
      ...readyMetadata(replacement),
      summary: { fileCount: 0, directoryCount: 1, totalBytes: 0, errorCount: 0 }
    }
    await restoredStorage.beginScan(replacement)
    await restoredStorage.applyBatch(replacement.id, [
      { type: 'entry', entry: emptyRoot },
      { type: 'directory-finalized', entry: { ...emptyRoot, aggregatedSizeBytes: 0 } }
    ])
    await restoredStorage.publishScan(empty, emptyRoot.id)
    await expect(restoredInsights.getSizeDistribution(request, signal)).rejects.toMatchObject({
      code: 'SNAPSHOT_EXPIRED'
    })
    await expect(
      restoredInsights.getSizeDistribution({ scanId: replacement.id }, signal)
    ).resolves.toMatchObject({
      scanId: replacement.id,
      knownSizeCount: 0,
      totals: { fileCount: 0, knownBytes: 0, unknownSizeCount: 0 }
    })
    await expect(restoredInsights.listLargest(request, 'directory', signal)).rejects.toMatchObject({
      code: 'SNAPSHOT_EXPIRED'
    })
    await expect(restoredInsights.getCategories(request, signal)).rejects.toMatchObject({
      code: 'SNAPSHOT_EXPIRED'
    })
    await expect(
      restoredInsights.listExtensions({ scanId: replacement.id }, signal)
    ).resolves.toMatchObject({
      scanId: replacement.id,
      totalCount: 0,
      nextOffset: null,
      extensions: []
    })
    await expect(restoredInsights.getSummary(request, signal)).rejects.toMatchObject({
      code: 'SNAPSHOT_EXPIRED'
    })
    await expect(restoredInsights.getSummary({ scanId: replacement.id }, signal)).resolves.toEqual({
      scanId: replacement.id,
      rootPath: replacement.rootPath,
      completedAt: empty.finishedAt,
      summary: empty.summary,
      incomplete: false
    })
  } finally {
    restoredStorage.stopReads()
    await duringStartup.catch(() => {})
  }
}, 15_000)

test.each([
  { bytes: 1n, code: null, message: /published scan summary/ },
  { bytes: 9_007_199_254_740_992n, code: 'SIZE_OVERFLOW', message: /supported size/ }
])(
  'returns a Worker error for inconsistent or overflowing distribution metadata ($code)',
  async ({ bytes, code, message }) => {
    const seed = bundled()
    await seed.initialize(databasePath)
    const saved = await preparePublication(seed, lifecycleScan('saved'))
    await seed.publishScan(saved, root.id)
    await seed.dispose()
    const fixture = new DatabaseSync(databasePath)
    try {
      fixture
        .prepare('UPDATE entries SET size_bytes = ? WHERE scan_id = ? AND id = ?')
        .run(bytes, saved.id, file.id)
    } finally {
      fixture.close()
    }
    // Reopen without recovery so the test reaches the distribution's own checks.
    const client = bundled()
    await client.initialize(databasePath)
    await expect(client.getInsightsSizeDistribution(saved.id)).rejects.toMatchObject({
      code,
      message: expect.stringMatching(message)
    })
  }
)

test('queries published Explorer snapshots through the Worker and returns structured errors', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.recoverStorage()
  await expect(client.getScanSnapshot()).resolves.toEqual({ snapshot: null, unavailable: null })
  const previous = await preparePublication(client, lifecycleScan('previous'))
  const rootRequest = { scanId: previous.id, entryId: root.id }
  const page = { ...rootRequest, offset: 0, limit: 100 }
  const fileRequest = { ...rootRequest, entryId: file.id }
  await expect(client.getScanEntry(fileRequest)).rejects.toMatchObject({
    name: 'SnapshotAccessError',
    code: 'SNAPSHOT_UNAVAILABLE',
    sqliteCode: null
  })
  await client.publishScan(previous, root.id)
  const snapshot = client.getScanSnapshot()
  await expect(client.listScanDirectory(page)).rejects.toThrow('already in flight')
  await expect(snapshot).resolves.toEqual({
    snapshot: {
      entries: { scanId: previous.id, rootEntryId: root.id },
      root: { ...root, scanId: previous.id, aggregatedSizeBytes: 0 },
      completedAt: previous.finishedAt,
      summary: previous.summary,
      entryCount: 2,
      incomplete: false
    },
    unavailable: null
  })
  await expect(client.getScanEntry(fileRequest)).resolves.toEqual({ ...file, scanId: previous.id })
  await expect(client.listScanDirectory(page)).resolves.toEqual({
    scanId: previous.id,
    directoryId: root.id,
    entries: [{ ...file, scanId: previous.id }],
    totalCount: 1,
    nextOffset: null
  })
  await expect(
    client.listScanDirectory({ ...page, offset: Number.MAX_SAFE_INTEGER })
  ).resolves.toMatchObject({
    entries: [],
    totalCount: 1,
    nextOffset: null
  })
  for (const [request, code] of [
    [{ ...page, limit: 101 }, 'INVALID_REQUEST'],
    [{ ...page, offset: -1 }, 'INVALID_REQUEST'],
    [{ ...page, scanId: '\0' }, 'INVALID_REQUEST'],
    [{ ...page, entryId: '../root' }, 'INVALID_REQUEST'],
    [{ ...page, entryId: file.id }, 'NOT_DIRECTORY'],
    [{ ...page, entryId: 'missing' }, 'ENTRY_NOT_FOUND']
  ] as const) {
    await expect(client.listScanDirectory(request)).rejects.toMatchObject({
      name: 'SnapshotAccessError',
      code,
      sqliteCode: null
    })
  }
  await expect(client.getScanEntry({ ...rootRequest, entryId: 'missing' })).rejects.toMatchObject({
    code: 'ENTRY_NOT_FOUND'
  })

  const next = await preparePublication(client, lifecycleScan('next'))
  await expect(client.listScanDirectory({ ...page, scanId: next.id })).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE'
  })
  await expect(client.getScanSnapshot()).resolves.toMatchObject({
    snapshot: { entries: { scanId: previous.id } }
  })
  await client.publishScan(next, root.id)
  await expect(client.getScanEntry(fileRequest)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' })
  await expect(client.listScanDirectory(page)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' })
  await client.dispose()
  await expect(client.getScanSnapshot()).rejects.toThrow('closing or closed')
  await expect(client.getScanEntry(rootRequest)).rejects.toThrow('closing or closed')
  await expect(client.listScanDirectory(page)).rejects.toThrow('closing or closed')

  const reopened = bundled()
  await reopened.initialize(databasePath)
  await reopened.recoverStorage()
  await expect(reopened.getScanSnapshot()).resolves.toMatchObject({
    snapshot: { entries: { scanId: next.id } }
  })
  await expect(reopened.getScanEntry({ ...fileRequest, scanId: next.id })).resolves.toEqual({
    ...file,
    scanId: next.id
  })
})

test('bounds Explorer and Insights results for a directory with more than 100,000 children', async () => {
  const pending = lifecycleScan('wide')
  const count = 100_017
  const totalBytes = (count * (count - 1)) / 2
  const label = (index: number): string => `file-${String(index).padStart(6, '0')}`
  // Seed the read fixture in one transaction so the test does not depend on disk sync speed.
  const seed = new ScanDatabase(databasePath)
  try {
    seed.beginScan(pending)
    seed.transaction(() => {
      seed.insertEntry({ ...root, scanId: pending.id, aggregatedSizeBytes: totalBytes })
      for (let index = count - 1; index >= 0; index--) {
        const id = label(index)
        const name = index >= 9_998 && index <= 10_002 ? label(9_998) : id
        seed.insertEntry({
          ...file,
          id,
          scanId: pending.id,
          name,
          path: join(rootPath, name),
          sizeBytes: index
        })
      }
    })
    const metadata = readyMetadata(pending)
    seed.publishScan(
      { ...metadata, summary: { ...metadata.summary, fileCount: count, totalBytes } },
      root.id
    )
  } finally {
    seed.close()
  }
  const client = bundled()
  await client.initialize(databasePath)
  for (const [offset, length, nextOffset] of [
    [0, 100, 100],
    [9_900, 100, 10_000],
    [10_000, 100, 10_100],
    [100_000, 17, null],
    [count, 0, null]
  ] as const) {
    const page = await client.listScanDirectory({
      scanId: pending.id,
      entryId: root.id,
      offset,
      limit: 100
    })
    expect(page.totalCount).toBe(count)
    expect(page.nextOffset).toBe(nextOffset)
    expect(page.entries.map((entry) => entry.id)).toEqual(
      Array.from({ length }, (_, i) => label(offset + i))
    )
  }
  const ranked = await client.getScanDirectoryTreemap({ scanId: pending.id, entryId: root.id })
  const otherCount = count - 100
  expect(ranked.entries.map(({ id }) => id)).toEqual(
    Array.from({ length: 100 }, (_, i) => label(count - 1 - i))
  )
  expect(ranked).toMatchObject({
    totalCount: count,
    individualCount: 100,
    unknownCount: 0,
    other: {
      count: otherCount,
      knownBytes: (otherCount * (otherCount - 1)) / 2,
      zeroCount: 1,
      unknownCount: 0
    }
  })
  const totals = { fileCount: count, knownBytes: totalBytes, unknownSizeCount: 0 }
  const distribution = await client.getInsightsSizeDistribution(pending.id)
  expect(distribution).toMatchObject({ knownSizeCount: count, totals })
  expect(distribution.buckets).toHaveLength(6)
  expect(distribution.buckets[0]).toEqual({ id: 'empty', fileCount: 1, knownBytes: 0 })
  expect(distribution.buckets[1]).toEqual({
    id: 'tiny',
    fileCount: count - 1,
    knownBytes: totalBytes
  })
  const first = await client.listInsightsLargestFiles({ scanId: pending.id, offset: 0, limit: 10 })
  const second = await client.listInsightsLargestFiles({
    scanId: pending.id,
    offset: 10,
    limit: 10
  })
  expect(first).toMatchObject({ totalCount: 20, nextOffset: 10 })
  expect(second).toMatchObject({ totalCount: 20, nextOffset: null })
  expect([...first.entries, ...second.entries].map(({ id }) => id)).toEqual(
    Array.from({ length: 20 }, (_, i) => label(count - 1 - i))
  )
  await expect(client.getInsightsCategories(pending.id)).resolves.toMatchObject({
    totals,
    categories: [{ category: 'other', ...totals }]
  })
  await expect(
    client.listInsightsExtensions({ scanId: pending.id, offset: 0, limit: 1 })
  ).resolves.toMatchObject({
    totals,
    totalCount: 1,
    nextOffset: null,
    extensions: [{ extension: null, ...totals }]
  })
}, 15_000)

test('runs Treemap queries through the real Worker after recovery and returns typed request errors', async () => {
  const seed = bundled()
  await seed.initialize(databasePath)
  const saved = await preparePublication(seed, lifecycleScan('saved'))
  await seed.publishScan(saved, root.id)
  await seed.dispose()
  const client = bundled()
  await client.initialize(databasePath)
  await client.recoverStorage()
  const request = { scanId: saved.id, entryId: root.id, limit: 1 }
  await expect(client.getScanDirectoryTreemap(request)).resolves.toEqual({
    scanId: saved.id,
    directoryId: root.id,
    entries: [{ ...file, scanId: saved.id }],
    totalCount: 1,
    individualCount: 1,
    unknownCount: 0,
    other: null
  })
  for (const [input, code] of [
    [{ ...request, limit: 101 }, 'INVALID_REQUEST'],
    [{ ...request, entryId: file.id }, 'NOT_DIRECTORY'],
    [{ ...request, entryId: 'missing' }, 'ENTRY_NOT_FOUND'],
    [{ ...request, scanId: 'expired' }, 'SNAPSHOT_EXPIRED']
  ] as const) {
    await expect(client.getScanDirectoryTreemap(input)).rejects.toMatchObject({
      name: 'SnapshotAccessError',
      code
    })
  }
  await client.dispose()
  await expect(client.getScanDirectoryTreemap(request)).rejects.toThrow('closing or closed')
})

test('rejects a Worker Treemap response with inconsistent Other counts', async () => {
  const worker = start(`
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', ({ requestId, operation }) => {
      const result = operation === 'getScanDirectoryTreemap'
        ? { scanId: 'scan-a', directoryId: 'root', entries: [${JSON.stringify(file)}], totalCount: 2,
            individualCount: 1, unknownCount: 0, other: { count: 1, knownBytes: 5, unknownCount: 1, zeroCount: 1 } }
        : null
      parentPort.postMessage({ requestId, ok: true, result })
    })
  `)
  const client = wrap(worker)
  await client.initialize(databasePath)
  await expect(
    client.getScanDirectoryTreemap({ scanId: 'scan-a', entryId: 'root' })
  ).rejects.toThrow('invalid response')
  await expect(client.dispose()).rejects.toThrow('invalid response')
  expectReleased(worker)
})

test('rejects a malformed Worker page response and terminates the client', async () => {
  const worker = start(`
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', ({ requestId, operation }) => {
      const result = operation === 'listScanDirectory'
        ? { scanId: 'scan-a', directoryId: 'root', entries: Array(101).fill(null), totalCount: 101, nextOffset: null }
        : null
      parentPort.postMessage({ requestId, ok: true, result })
    })
  `)
  const client = wrap(worker)
  await client.initialize(databasePath)
  await expect(
    client.listScanDirectory({ scanId: 'scan-a', entryId: 'root', offset: 0, limit: 100 })
  ).rejects.toThrow('invalid response')
  await expect(client.dispose()).rejects.toThrow('invalid response')
  expectReleased(worker)
})

test('allows startup recovery before any writes and rejects recovery during a legitimate scan', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.recoverStorage()
  const building = await preparePublication(client, lifecycleScan('active'))
  await expect(client.recoverStorage()).rejects.toThrow(/recovery/i)
  expect((await client.getScan(building.id))?.status).toBe('running')
  await client.publishScan(building, root.id)
  await expect(client.getPublishedScan()).resolves.toEqual(building)
})

test('makes a failed startup recovery terminal without removing persisted rows', async () => {
  const seed = bundled()
  await seed.initialize(databasePath)
  const previous = await preparePublication(seed, lifecycleScan('previous'))
  await seed.publishScan(previous, root.id)
  await preparePublication(seed, lifecycleScan('interrupted'))
  await seed.insertScan({ ...previous, id: 'ambiguous' })
  await seed.dispose()

  const client = bundled()
  await client.initialize(databasePath)
  await expect(client.recoverStorage()).rejects.toThrow('more than one completed scan')
  await expect(client.beginScan(lifecycleScan('new'))).rejects.toThrow(
    'more than one completed scan'
  )
  await expect(client.dispose()).rejects.toThrow('more than one completed scan')
  using observer = new DatabaseSync(databasePath, { readOnly: true })
  expect(observer.prepare('SELECT id, status FROM scans ORDER BY id').all()).toEqual([
    { id: 'ambiguous', status: 'completed' },
    { id: 'interrupted', status: 'running' },
    { id: 'previous', status: 'completed' }
  ])
  expect(observer.prepare('SELECT COUNT(*) AS count FROM entries').get()?.count).toBe(4)
})

test.each(['before commit', 'before acknowledgment'])(
  'recovers after worker exit %s',
  async (point) => {
    const worker = start(`
    const { parentPort } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    let publishing = false
    parentPort.on('message', request => {
      publishing = request.operation === 'publishScan' && request.payload.scan.id === 'next'
    })
    if (${JSON.stringify(point)} === 'before commit') {
      const exec = DatabaseSync.prototype.exec
      DatabaseSync.prototype.exec = function (sql) {
        if (publishing && sql === 'COMMIT') process.exit(1)
        return exec.call(this, sql)
      }
    } else {
      const send = parentPort.postMessage.bind(parentPort)
      parentPort.postMessage = response => {
        if (publishing && response.ok) process.exit(1)
        return send(response)
      }
    }
    require(${JSON.stringify(workerPath)})
  `)
    const sent = vi.spyOn(worker, 'postMessage')
    const client = wrap(worker)
    await client.initialize(databasePath)
    await client.recoverStorage()
    const previous = await preparePublication(client, lifecycleScan('previous'))
    await client.publishScan(previous, root.id)
    const next = await preparePublication(client, lifecycleScan('next'))
    sent.mockClear()
    await expect(client.publishScan(next, root.id)).rejects.toThrow('exited unexpectedly')
    await expect(client.beginScan(lifecycleScan('new'))).rejects.toThrow('exited unexpectedly')
    await expect(client.dispose()).rejects.toThrow('exited unexpectedly')
    expect(sent).toHaveBeenCalledOnce()
    expectReleased(worker)

    const reopened = bundled()
    await reopened.initialize(databasePath)
    await reopened.recoverStorage()
    const [retained, removed] = point === 'before commit' ? [previous, next] : [next, previous]
    await expect(reopened.getPublishedScan()).resolves.toEqual(retained)
    await expect(reopened.getEntry(retained.id, file.id)).resolves.toEqual({
      ...file,
      scanId: retained.id
    })
    await expect(reopened.getScan(removed.id)).resolves.toBeNull()
    await expect(reopened.getEntry(removed.id, file.id)).resolves.toBeNull()
    await expect(reopened.discardBuildingScan(removed.id)).rejects.toThrow('not a building scan')
    await expect(reopened.getPublishedScan()).resolves.toEqual(retained)
  }
)

test('publishes over the worker boundary after commit and reopens the replacement', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await expect(client.getPublishedScan()).resolves.toBeNull()
  const previous = await preparePublication(client, lifecycleScan('previous'))
  await expect(client.getPublishedScan()).resolves.toBeNull()
  await client.publishScan(previous, root.id)
  const next = await preparePublication(client, lifecycleScan('next'))
  await expect(client.getPublishedScan()).resolves.toEqual(previous)

  await expect(
    client.publishScan({ ...next, summary: { ...next.summary, directoryCount: 2 } }, root.id)
  ).rejects.toMatchObject({
    name: 'Error',
    message: expect.stringContaining('differ from the scan summary'),
    code: null
  })
  await expect(client.getPublishedScan()).resolves.toEqual(previous)
  const publishing = client.publishScan(next, root.id)
  await expect(client.getPublishedScan()).rejects.toThrow('already in flight')
  await publishing

  const observer = new DatabaseSync(databasePath, { readOnly: true })
  try {
    expect(observer.prepare('SELECT id, status FROM scans').all()).toEqual([
      { id: next.id, status: 'completed' }
    ])
    expect(
      observer.prepare('SELECT COUNT(*) AS count FROM entries WHERE scan_id = ?').get(previous.id)
        ?.count
    ).toBe(0)
  } finally {
    observer.close()
  }
  await client.dispose()

  const reopened = bundled()
  await reopened.initialize(databasePath)
  await expect(reopened.getPublishedScan()).resolves.toEqual(next)
  await expect(reopened.getEntry(next.id, file.id)).resolves.toEqual({ ...file, scanId: next.id })
})

test('validates lifecycle payloads and scopes discard and stale requests to their scan', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  const pending = lifecycleScan('pending')
  await expect(client.beginScan({ ...pending, startedAt: 'bad' })).rejects.toMatchObject({
    name: 'TypeError',
    message: expect.stringContaining('valid running scan metadata'),
    code: null
  })
  const previous = await preparePublication(client, lifecycleScan('previous'))
  await client.publishScan(previous, root.id)
  const rejected = await preparePublication(client, pending)
  await expect(client.publishScan(rejected, 'invalid root ID')).rejects.toMatchObject({
    name: 'TypeError',
    message: expect.stringContaining('valid root entry ID'),
    code: null
  })
  await expect(client.discardBuildingScan(previous.id)).rejects.toThrow('not a building scan')
  await client.discardBuildingScan(rejected.id)
  const next = await preparePublication(client, lifecycleScan('next'))
  await expect(client.discardBuildingScan(rejected.id)).rejects.toThrow('not a building scan')
  await expect(client.publishScan(rejected, root.id)).rejects.toThrow('not a building scan')
  await expect(client.getEntry(rejected.id, root.id)).resolves.toBeNull()
  await expect(client.getPublishedScan()).resolves.toEqual(previous)
  await client.publishScan(next, root.id)
  await expect(client.getPublishedScan()).resolves.toEqual(next)
  await client.dispose()
  await expect(client.getPublishedScan()).rejects.toThrow('closing or closed')
})

test('propagates a constraint error and accepts subsequent requests on the same connection', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  await client.insertScan(scan)
  await expect(client.insertEntry(file)).rejects.toMatchObject({
    message: 'FOREIGN KEY constraint failed',
    code: 'ERR_SQLITE_ERROR',
    sqliteCode: 787
  })
  await expect(client.getEntry(scan.id, file.id)).resolves.toBeNull()
  await client.insertEntry(root)
  await client.insertEntry(file)
  await expect(client.getEntry(scan.id, file.id)).resolves.toEqual(file)
})

test('reports a database open failure and releases the worker', async () => {
  const worker = start()
  const client = wrap(worker)
  const missingPath = join(dirname(databasePath), 'missing', 'data.sqlite')
  await expect(client.initialize(missingPath)).rejects.toMatchObject({
    message: expect.stringContaining('Could not open the scan database'),
    code: 'ERR_SQLITE_ERROR'
  })
  await expect(client.dispose()).rejects.toThrow('Could not open the scan database')
  expectReleased(worker)
})

test('closes the database and reopens persisted data in a new worker', async () => {
  const worker = start()
  const client = wrap(worker)
  await client.initialize(databasePath)
  await client.insertScan(scan)
  await client.insertEntry(root)
  const closing = client.dispose()
  expect(client.dispose()).toBe(closing)
  await closing
  expect(client.dispose()).toBe(closing)
  expectReleased(worker)
  await expect(client.insertScan(scan)).rejects.toThrow('closing or closed')
  await expect(client.getEntry(scan.id, root.id)).rejects.toThrow('closing or closed')

  const reopened = bundled()
  await reopened.initialize(databasePath)
  await expect(reopened.getScan(scan.id)).resolves.toEqual(scan)
  await expect(reopened.getEntry(scan.id, root.id)).resolves.toEqual(root)
})

test('drains initialization during shutdown and rejects new operations immediately', async () => {
  const worker = start()
  const client = wrap(worker)
  const ready = client.initialize(databasePath)
  const closing = client.dispose()
  expect(client.dispose()).toBe(closing)
  await expect(client.getScan(scan.id)).rejects.toThrow('closing or closed')
  await expect(ready).resolves.toBeUndefined()
  await expect(closing).resolves.toBeUndefined()
  expectReleased(worker)
})

test('can close an uninitialized worker without opening a database', async () => {
  const worker = start()
  const client = wrap(worker)
  await client.dispose()
  await expect(client.initialize(databasePath)).rejects.toThrow('state closed')
  await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  expectReleased(worker)
})

test('processes messages in arrival order and correlates every response with its request ID', async () => {
  const worker = start()
  const received: unknown[] = []
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  worker.on('message', (message: unknown) => {
    received.push(message)
    if (received.length === 4) resolve()
  })
  worker.once('error', reject)
  const exited = once(worker, 'exit')
  const requests = [
    { requestId: 9, operation: 'initialize', payload: { databasePath } },
    { requestId: 3, operation: 'insertScan', payload: scan },
    { requestId: 7, operation: 'getScan', payload: { id: scan.id } },
    { requestId: 5, operation: 'close', payload: null }
  ] satisfies StorageRequest[]
  for (const request of requests) worker.postMessage(request)

  await Promise.race([
    promise,
    exited.then(() => {
      if (received.length !== 4) throw new Error('Worker exited before all replies.')
    })
  ])
  expect(received).toEqual([
    { requestId: 9, ok: true, result: null },
    { requestId: 3, ok: true, result: null },
    { requestId: 7, ok: true, result: scan },
    { requestId: 5, ok: true, result: null }
  ])
  await expect(exited).resolves.toEqual([0])
})

test('validates commands and rejects unsafe numeric payloads without closing the connection', async () => {
  const client = bundled()
  await client.initialize(databasePath)
  const invalidScan = {
    ...scan,
    summary: { ...scan.summary, fileCount: Number.MAX_SAFE_INTEGER + 1 }
  }
  await expect(client.insertScan(invalidScan)).rejects.toMatchObject({
    name: 'TypeError',
    message: 'Invalid payload for storage operation insertScan.'
  })
  await expect(client.getScan(scan.id)).resolves.toBeNull()
  await client.insertScan(scan)
  await client.insertEntry(root)
  await expect(client.insertEntry({ ...file, sizeBytes: 1.5 })).rejects.toThrow('Invalid payload')
  await expect(client.getEntry(scan.id, file.id)).resolves.toBeNull()
  await client.insertEntry(file)
})

test('rejects an unknown command with a correlated structured error', async () => {
  const worker = start()
  const response = once(worker, 'message')
  worker.postMessage({ requestId: 8, operation: 'exec', payload: 'SELECT 1' })
  await expect(response).resolves.toEqual([
    {
      requestId: 8,
      ok: false,
      error: {
        name: 'TypeError',
        message: 'Unknown storage operation.',
        code: null,
        sqliteCode: null
      }
    }
  ])
  await wrap(worker).dispose()
})

test('rejects a pending request when the worker exits without a response', async () => {
  const worker = start(
    `require('node:worker_threads').parentPort.once('message', () => process.exit(0))`
  )
  const client = wrap(worker)
  await expect(client.initialize(databasePath)).rejects.toThrow('exited unexpectedly (code 0)')
  await expect(client.dispose()).rejects.toThrow('exited unexpectedly')
  expectReleased(worker)
})

test('rejects an outstanding read and future calls on an uncaught worker error', async () => {
  const worker = start(`
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', ({ requestId, operation }) => {
      if (operation !== 'initialize') throw new Error('Worker crashed during a read.')
      parentPort.postMessage({ requestId, ok: true, result: null })
    })
  `)
  const client = wrap(worker)
  await client.initialize(databasePath)
  await expect(client.getScan(scan.id)).rejects.toThrow('Worker crashed during a read.')
  await expect(client.getScan(scan.id)).rejects.toThrow('Worker crashed during a read.')
  await expect(client.dispose()).rejects.toThrow('Worker crashed during a read.')
  expectReleased(worker)
})

test('turns an uncaught non-Error value into a terminal client error', async () => {
  const worker = start(
    `require('node:worker_threads').parentPort.once('message', () => { throw null })`
  )
  const client = wrap(worker)
  await expect(client.initialize(databasePath)).rejects.toMatchObject({
    message: 'Storage worker threw an uncaught value.',
    cause: null
  })
  await expect(client.dispose()).rejects.toThrow('Storage worker threw an uncaught value.')
  expectReleased(worker)
})

test.each([
  ['request ID', '{ requestId: requestId + 1, ok: true, result: null }'],
  ['response shape', '{ requestId, ok: true, result: {} }']
])('rejects a mismatched %s and terminates the worker', async (_, reply) => {
  const worker = start(`
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', ({ requestId }) => parentPort.postMessage(${reply}))
  `)
  const client = wrap(worker)
  await expect(client.initialize(databasePath)).rejects.toThrow('invalid response')
  await expect(client.dispose()).rejects.toThrow('invalid response')
  expectReleased(worker)
})

test('terminates a worker that never acknowledges initialization', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const worker = start(`require('node:worker_threads').parentPort.on('message', () => {})`)
  const client = wrap(worker)
  const rejected = expect(client.initialize(databasePath)).rejects.toThrow(
    'initialize request timed out'
  )
  await vi.advanceTimersByTimeAsync(STORAGE_REQUEST_TIMEOUT_MS)
  await rejected
  await expect(client.dispose()).rejects.toThrow('initialize request timed out')
  expectReleased(worker)
})

test('times out an unacknowledged batch and never sends another write', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const worker = start(`
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', ({ requestId, operation }) => {
      if (operation === 'initialize') parentPort.postMessage({ requestId, ok: true, result: null })
    })
  `)
  const client = wrap(worker)
  await client.initialize(databasePath)
  const send = vi.spyOn(worker, 'postMessage')
  const pending = expect(client.applyBatch(scan.id, [])).rejects.toThrow(
    'applyBatch request timed out'
  )
  await vi.advanceTimersByTimeAsync(STORAGE_REQUEST_TIMEOUT_MS)
  await pending
  await expect(client.discardBuildingScan(scan.id)).rejects.toThrow('applyBatch request timed out')
  await expect(client.beginScan(lifecycleScan('new'))).rejects.toThrow(
    'applyBatch request timed out'
  )
  await expect(client.dispose()).rejects.toThrow('applyBatch request timed out')
  expect(send).toHaveBeenCalledOnce()
  expectReleased(worker)
})

test('settles shutdown and the pending request when initialization stalls', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const worker = start(`require('node:worker_threads').parentPort.on('message', () => {})`)
  const client = wrap(worker)
  const ready = expect(client.initialize(databasePath)).rejects.toThrow('shutdown timed out')
  const closing = expect(client.dispose()).rejects.toThrow('shutdown timed out')
  await vi.advanceTimersByTimeAsync(STORAGE_SHUTDOWN_TIMEOUT_MS)
  await Promise.all([ready, closing])
  expectReleased(worker)
})

test('requires an actual normal exit after the close acknowledgment', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const worker = start(`
    const { parentPort } = require('node:worker_threads')
    parentPort.on('message', ({ requestId }) => parentPort.postMessage({ requestId, ok: true, result: null }))
  `)
  const client = wrap(worker)
  await client.initialize(databasePath)
  const reply = once(worker, 'message')
  const closing = expect(client.dispose()).rejects.toThrow('shutdown timed out')
  await reply
  await vi.advanceTimersByTimeAsync(STORAGE_SHUTDOWN_TIMEOUT_MS)
  await closing
  expectReleased(worker)
})

test('bounds disposal even if force termination itself cannot complete', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const worker = start(`require('node:worker_threads').parentPort.on('message', () => {})`)
  const client = wrap(worker)
  const terminate = vi.spyOn(worker, 'terminate').mockReturnValue(new Promise<number>(() => {}))
  const closing = expect(client.dispose()).rejects.toThrow('did not exit after forced termination')
  await vi.advanceTimersByTimeAsync(STORAGE_SHUTDOWN_TIMEOUT_MS * 2)
  await closing
  expect(terminate).toHaveBeenCalledOnce()

  terminate.mockRestore()
  await worker.terminate()
  expectReleased(worker)
})
