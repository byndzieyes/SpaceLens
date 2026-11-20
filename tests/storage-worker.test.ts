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
import { SCANNER_BATCH_SIZE } from '../src/main/scanner/workerProtocol'
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
