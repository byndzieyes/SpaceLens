// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getEventListeners, once } from 'node:events'
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { scanDirectory } from '../src/main/scanner/scan'
import { consumeScannerWorker } from '../src/main/scanner/workerClient'
import { ScanCancelledError, SCANNER_CANCEL_TIMEOUT_MS } from '../src/main/scanner/cancellation'
import {
  SCANNER_BATCH_SIZE,
  parseScannerWorkerMessage,
  type ScannerWorkerMessage
} from '../src/main/scanner/workerProtocol'
import type { ScanOutputEvent, ScanSummaryEvent } from '../src/main/scanner/summary'
import type { runScannerWorker } from '../src/main/scanner/workerRunner'
import type { ScanProgress } from '../src/shared/scan'

const require = createRequire(import.meta.url)
const scanId = 'worker-test'
const workers = new Set<Worker>()
const artifacts = new Map<string, { runner: typeof runScannerWorker; workerPath: string }>()
let suitePath: string
let rootPath: string
let workerPath: string

beforeAll(async () => {
  suitePath = await mkdtemp(join(tmpdir(), 'spacelens-worker-'))
  const previousMode = process.env.NODE_ENV_ELECTRON_VITE
  try {
    for (const mode of ['development', 'production']) {
      process.env.NODE_ENV_ELECTRON_VITE = mode
      // The same resolveConfig + Vite Main build used by electron-vite's dev/build commands.
      const config = await resolveConfig(
        {
          root: process.cwd(),
          mode,
          logLevel: 'silent',
          build: { outDir: join(suitePath, mode) }
        },
        mode === 'development' ? 'serve' : 'build',
        mode
      )
      const main = config.config?.main
      if (!main) throw new Error('Missing Electron Main build configuration')
      await build(main)
      const builtPath = join(suitePath, mode, 'main')
      const relocated = join(suitePath, `${mode}-relocated`)
      await cp(builtPath, relocated, { recursive: true })
      const files = await readdir(relocated, { recursive: true })
      const worker = files.find((file) => /^scanner\.worker-.*\.js$/.test(basename(file)))
      if (!worker) throw new Error('Missing generated scanner worker chunk')
      const module = require(join(relocated, 'scannerWorkerRunner.js')) as {
        runScannerWorker: typeof runScannerWorker
      }
      artifacts.set(mode, { runner: module.runScannerWorker, workerPath: join(relocated, worker) })
    }
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV_ELECTRON_VITE
    else process.env.NODE_ENV_ELECTRON_VITE = previousMode
  }
  workerPath = artifacts.get('production')!.workerPath
}, 60_000)

beforeEach(async () => {
  rootPath = await mkdtemp(join(suitePath, 'data-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const worker of workers) await worker.terminate()
  workers.clear()
})

afterAll(async () => {
  const target = resolve(suitePath)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('spacelens-worker-')) {
    throw new Error('Refusing to remove a path outside temporary worker fixtures')
  }
  await rm(target, { recursive: true, force: true })
})

function start(
  script?: string,
  extra: Record<string, unknown> = {},
  transferList: MessagePort[] = []
): Worker {
  const worker = new Worker(script ?? workerPath, {
    eval: script !== undefined,
    workerData: { rootPath, scanId, workerPath, ...extra },
    transferList
  })
  workers.add(worker)
  return worker
}

function expectReleased(worker: Worker): void {
  expect(worker.threadId).toBe(-1)
  for (const event of ['message', 'messageerror', 'error', 'exit']) {
    expect(worker.listenerCount(event)).toBe(0)
  }
}

function normalize(events: ScanOutputEvent[]): unknown[] {
  const paths = new Map<string, string>()
  for (const event of events)
    if (event.type === 'entry') paths.set(event.entry.id, event.entry.path)
  return events
    .map((event) => {
      if (event.type === 'summary') return { ...event, rootEntryId: paths.get(event.rootEntryId) }
      if (event.type === 'error') return event
      return {
        ...event,
        entry: {
          ...event.entry,
          id: event.entry.path,
          parentId: event.entry.parentId === null ? null : paths.get(event.entry.parentId)
        }
      }
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test.each(['development', 'production'])(
  'cancels before %s runner startup without creating a worker',
  async (mode) => {
    const controller = new AbortController()
    controller.abort(new Error('Caller reason'))
    const threadModule = require('node:worker_threads') as typeof import('node:worker_threads')
    const construct = vi.spyOn(threadModule, 'Worker')
    const consume = vi.fn()
    const progress = vi.fn()
    await expect(
      artifacts.get(mode)!.runner(rootPath, scanId, consume, {
        signal: controller.signal,
        onProgress: progress
      })
    ).rejects.toMatchObject({ name: 'ScanCancelledError', code: 'SCAN_CANCELLED' })
    expect(construct).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  }
)

test('cooperatively cancels during filesystem work and closes open directory handles', async () => {
  await mkdir(join(rootPath, 'nested'))
  const blocked = join(rootPath, 'nested', 'file')
  await writeFile(blocked, 'abc')
  const { port1, port2 } = new MessageChannel()
  const counters = new SharedArrayBuffer(8)
  const worker = start(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs/promises');
    const counts = new Int32Array(workerData.counters);
    const originalOpen = fs.opendir;
    fs.opendir = async (...args) => {
      const dir = await originalOpen(...args);
      Atomics.add(counts, 0, 1);
      const close = dir.close.bind(dir);
      dir.close = async () => { await close(); Atomics.add(counts, 1, 1); };
      return dir;
    };
    const originalStat = fs.lstat;
    fs.lstat = async (path, ...args) => {
      if (path === workerData.blocked) {
        await new Promise(resolve => {
          parentPort.once('message', () => resolve());
          workerData.control.postMessage('reading');
        });
        workerData.control.close();
      }
      return originalStat(path, ...args);
    };
    require(workerData.workerPath);
  `,
    { control: port2, counters, blocked },
    [port2]
  )
  const controller = new AbortController()
  const consume = vi.fn()
  const progress = vi.fn()
  const terminate = vi.spyOn(worker, 'terminate')
  const messages: unknown[] = []
  const observe = (message: unknown): void => {
    messages.push(message)
  }
  worker.on('message', observe)
  const result = consumeScannerWorker(worker, scanId, consume, {
    signal: controller.signal,
    onProgress: progress
  })
  const assertion = expect(result).rejects.toBeInstanceOf(ScanCancelledError)
  try {
    expect(await once(port1, 'message')).toEqual(['reading'])
    controller.abort()
    await assertion
    expect(Array.from(new Int32Array(counters))).toEqual([2, 2])
    expect(messages).toEqual([{ type: 'cancelled', scanId }])
    expect(consume).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
  } finally {
    port1.close()
    worker.off('message', observe)
  }
  expectReleased(worker)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

test('cancels a large scan while an event consumer is pending without waiting for that callback', async () => {
  for (let index = 0; index < SCANNER_BATCH_SIZE * 2; index++)
    await writeFile(join(rootPath, `file-${index}`), 'x')
  const worker = start()
  const controller = new AbortController()
  const ready = deferred()
  const gate = deferred()
  const sent = vi.spyOn(worker, 'postMessage')
  const terminate = vi.spyOn(worker, 'terminate')
  const consume = vi.fn(async () => {
    ready.resolve()
    await gate.promise
  })
  const progress = vi.fn()
  const result = consumeScannerWorker(worker, scanId, consume, {
    signal: controller.signal,
    onProgress: progress
  })
  const assertion = expect(result).rejects.toBeInstanceOf(ScanCancelledError)
  await ready.promise
  controller.abort()
  controller.abort()
  await assertion
  expect(sent.mock.calls).toEqual([[{ type: 'cancel', scanId }]])
  expect(terminate).not.toHaveBeenCalled()
  expect(consume).toHaveBeenCalledOnce()
  expect(progress).not.toHaveBeenCalled()
  expectReleased(worker)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  gate.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(sent).toHaveBeenCalledOnce()
  expect(consume).toHaveBeenCalledOnce()
})

test('cancels while a progress consumer is pending and sends no acknowledgment', async () => {
  const worker = start()
  const controller = new AbortController()
  const ready = deferred()
  const gate = deferred()
  const sent = vi.spyOn(worker, 'postMessage')
  const progress = vi.fn(async () => {
    ready.resolve()
    await gate.promise
  })
  const result = consumeScannerWorker(worker, scanId, () => {}, {
    signal: controller.signal,
    onProgress: progress
  })
  const assertion = expect(result).rejects.toBeInstanceOf(ScanCancelledError)
  await ready.promise
  controller.abort()
  await assertion
  gate.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(sent.mock.calls).toEqual([[{ type: 'cancel', scanId }]])
  expect(progress).toHaveBeenCalledOnce()
  expectReleased(worker)
})

test('worker accepts cancellation without a batch acknowledgment and sends only one terminal reply', async () => {
  const worker = start()
  const exit = once(worker, 'exit')
  const first = await once(worker, 'message')
  expect(first[0].type).toBe('batch')
  const messages: unknown[] = []
  const observe = (message: unknown): void => {
    messages.push(message)
  }
  worker.on('message', observe)
  worker.postMessage({ type: 'cancel', scanId })
  worker.postMessage({ type: 'cancel', scanId })
  expect(await exit).toEqual([0])
  expect(messages).toEqual([{ type: 'cancelled', scanId }])
  worker.off('message', observe)
  expectReleased(worker)
})

test.each(['entry', 'summary'] as const)(
  'generated production runner cancels from the %s callback near completion',
  async (stopAt) => {
    const controller = new AbortController()
    const types: string[] = []
    const progress = vi.fn()
    await expect(
      artifacts.get('production')!.runner(
        rootPath,
        scanId,
        (event) => {
          types.push(event.type)
          if (event.type === stopAt) controller.abort()
        },
        { signal: controller.signal, onProgress: progress }
      )
    ).rejects.toMatchObject({ code: 'SCAN_CANCELLED' })
    expect(types).toEqual(
      stopAt === 'entry' ? ['entry'] : ['entry', 'directory-finalized', 'summary']
    )
    expect(progress).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  }
)

test('aborting after normal completion has no effect and leaves no abort subscription', async () => {
  const controller = new AbortController()
  const worker = start()
  const sent = vi.spyOn(worker, 'postMessage')
  const progress = vi.fn()
  const result = await consumeScannerWorker(worker, scanId, () => {}, {
    signal: controller.signal,
    onProgress: progress
  })
  expect(result.summary.directoryCount).toBe(1)
  const messages = sent.mock.calls.length
  controller.abort()
  expect(sent).toHaveBeenCalledTimes(messages)
  expect(progress).toHaveBeenCalledOnce()
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expectReleased(worker)
})

test('fatal errors observed before cancellation retain their original outcome', async () => {
  const controller = new AbortController()
  const worker = start(undefined, { rootPath: join(rootPath, 'missing') })
  const result = consumeScannerWorker(worker, scanId, () => {}, { signal: controller.signal })
  await expect(result).rejects.toMatchObject({ code: 'ENOENT' })
  controller.abort()
  await expect(result).rejects.not.toBeInstanceOf(ScanCancelledError)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expectReleased(worker)
})

test.each(['complete', 'fatal', 'crash'] as const)(
  'late worker %s cannot replace an accepted cancellation',
  async (terminal) => {
    const worker = start(
      `
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.once('message', () => {
      if (workerData.terminal === 'crash') throw new Error('Late crash');
      if (workerData.terminal === 'fatal') parentPort.postMessage({ type: 'fatal', scanId: workerData.scanId,
        error: { name: 'Error', message: 'Late failure', code: 'EIO' } });
      else {
        parentPort.postMessage({ type: 'cancelled', scanId: workerData.scanId });
        parentPort.postMessage({ type: 'batch', scanId: workerData.scanId, sequence: 0, events: [] });
        parentPort.postMessage({ type: 'complete', scanId: workerData.scanId });
      }
      parentPort.close();
    });
  `,
      { terminal }
    )
    const controller = new AbortController()
    const consume = vi.fn()
    const progress = vi.fn()
    const result = consumeScannerWorker(worker, scanId, consume, {
      signal: controller.signal,
      onProgress: progress
    })
    const assertion = expect(result).rejects.toBeInstanceOf(ScanCancelledError)
    controller.abort()
    await assertion
    expect(consume).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
    expectReleased(worker)
  }
)

test('forces termination after the grace period when a worker cannot cooperate', async () => {
  const worker = start('setInterval(() => {}, 1000)')
  await once(worker, 'online')
  const controller = new AbortController()
  const terminate = vi.spyOn(worker, 'terminate')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = consumeScannerWorker(worker, scanId, () => {}, { signal: controller.signal })
  const assertion = expect(result).rejects.toBeInstanceOf(ScanCancelledError)
  controller.abort()
  expect(terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(SCANNER_CANCEL_TIMEOUT_MS)
  await assertion
  expect(terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expectReleased(worker)
})

test.each(['development', 'production'])(
  'launches the generated %s runner/worker from relocated JavaScript artifacts',
  async (mode) => {
    const events: ScanOutputEvent[] = []
    const progress: ScanProgress[] = []
    const result = await artifacts.get(mode)!.runner(
      rootPath,
      scanId,
      (event) => {
        events.push(event)
      },
      (snapshot) => {
        expect(events.at(-1)?.type).toBe('summary')
        progress.push(snapshot)
      }
    )
    expect(progress).toEqual([
      {
        scanId,
        processedFileCount: 0,
        processedDirectoryCount: 1,
        processedBytes: 0,
        currentPath: rootPath
      }
    ])
    expect(events.map((event) => event.type)).toEqual(['entry', 'directory-finalized', 'summary'])
    expect(result).toEqual(events.at(-1))
    expect(result.summary).toEqual({
      fileCount: 0,
      directoryCount: 1,
      totalBytes: 0,
      errorCount: 0
    })
  }
)

test('executes in a separate thread and matches direct scanning of nested files', async () => {
  await mkdir(join(rootPath, 'nested', 'empty'), { recursive: true })
  await writeFile(join(rootPath, 'first'), 'abc')
  await writeFile(join(rootPath, 'nested', 'second'), '12345')
  const direct: ScanOutputEvent[] = []
  for await (const event of scanDirectory(rootPath, scanId)) direct.push(event)
  const worker = start()
  expect(worker.threadId).toBeGreaterThan(0)
  const events: ScanOutputEvent[] = []
  const progress = vi.fn()
  const summary = await consumeScannerWorker(
    worker,
    scanId,
    (event) => {
      events.push(event)
    },
    progress
  )
  expect(progress).toHaveBeenCalledExactlyOnceWith({
    scanId,
    processedFileCount: 2,
    processedDirectoryCount: 3,
    processedBytes: 8,
    currentPath: rootPath
  })
  expect(normalize(events)).toEqual(normalize(direct))
  expect(summary.summary).toEqual({ fileCount: 2, directoryCount: 3, totalBytes: 8, errorCount: 0 })
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type === 'entry') {
      expect(seen.has(event.entry.id)).toBe(false)
      if (event.entry.parentId !== null) expect(seen.has(event.entry.parentId)).toBe(true)
      seen.add(event.entry.id)
    } else if (event.type === 'directory-finalized') {
      expect(seen.has(event.entry.id)).toBe(true)
    }
  }
  expect(events.at(-1)).toEqual(summary)
  expectReleased(worker)
})

test('keeps simultaneous scan IDs separate', async () => {
  const first: ScanOutputEvent[] = []
  const second: ScanOutputEvent[] = []
  const runner = artifacts.get('production')!.runner
  const results = await Promise.all([
    runner(rootPath, 'first', (event) => {
      first.push(event)
    }),
    runner(rootPath, 'second', (event) => {
      second.push(event)
    })
  ])
  expect(results.map((result) => result.scanId)).toEqual(['first', 'second'])
  expect(results[0].rootEntryId).not.toBe(results[1].rootEntryId)
  for (const [index, events] of [first, second].entries()) {
    for (const event of events) {
      if (event.type === 'entry' || event.type === 'directory-finalized') {
        expect(event.entry.scanId).toBe(results[index].scanId)
      }
    }
  }
})

test('preserves recoverable error events and partial known totals inside the actual worker', async () => {
  await writeFile(join(rootPath, 'private'), '')
  await writeFile(join(rootPath, 'known'), 'abc')
  const worker = start(
    `
    const { workerData } = require('node:worker_threads');
    const fs = require('node:fs/promises');
    const original = fs.lstat;
    fs.lstat = async (path, ...args) => {
      if (path === workerData.denied) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
      return original(path, ...args);
    };
    require(workerData.workerPath);
  `,
    { denied: join(rootPath, 'private') }
  )
  const events: ScanOutputEvent[] = []
  const progress = vi.fn()
  const result = await consumeScannerWorker(
    worker,
    scanId,
    (event) => {
      events.push(event)
    },
    progress
  )
  expect(progress).toHaveBeenCalledExactlyOnceWith({
    scanId,
    processedFileCount: 1,
    processedDirectoryCount: 1,
    processedBytes: 3,
    currentPath: rootPath
  })
  expect(events.filter((event) => event.type === 'error')).toEqual([
    {
      type: 'error',
      error: { path: join(rootPath, 'private'), code: 'EACCES', message: 'Access denied' }
    }
  ])
  expect(result.summary).toEqual({ fileCount: 1, directoryCount: 1, totalBytes: 3, errorCount: 1 })
  expectReleased(worker)
})

test('propagates fatal scanner errors and releases the worker', async () => {
  const worker = start(undefined, { rootPath: join(rootPath, 'missing') })
  const consume = vi.fn()
  const progress = vi.fn()
  await expect(consumeScannerWorker(worker, scanId, consume, progress)).rejects.toMatchObject({
    code: 'ENOENT'
  })
  expect(consume).not.toHaveBeenCalled()
  expect(progress).not.toHaveBeenCalled()
  expectReleased(worker)
})

test('flushes partial discoveries before a fatal failure without sending a summary', async () => {
  await writeFile(join(rootPath, 'bad'), '')
  const worker = start(
    `
    const { workerData } = require('node:worker_threads');
    const fs = require('node:fs/promises');
    const original = fs.lstat;
    fs.lstat = async (path, ...args) => {
      if (path === workerData.bad) throw new TypeError('Unexpected scanner failure');
      return original(path, ...args);
    };
    require(workerData.workerPath);
  `,
    { bad: join(rootPath, 'bad') }
  )
  const events: ScanOutputEvent[] = []
  const progress = vi.fn()
  await expect(
    consumeScannerWorker(
      worker,
      scanId,
      (event) => {
        events.push(event)
      },
      progress
    )
  ).rejects.toMatchObject({ name: 'TypeError', message: 'Unexpected scanner failure' })
  expect(events.map((event) => event.type)).toEqual(['entry'])
  expect(progress).toHaveBeenCalledExactlyOnceWith({
    scanId,
    processedFileCount: 0,
    processedDirectoryCount: 1,
    processedBytes: 0,
    currentPath: rootPath
  })
  expectReleased(worker)
})

test('bounds batches and pauses filesystem work until the matching acknowledgment', async () => {
  for (let index = 0; index < SCANNER_BATCH_SIZE * 2; index++) {
    await writeFile(join(rootPath, `file-${index}`), 'x')
  }
  const counter = new SharedArrayBuffer(4)
  const worker = start(
    `
    const { workerData } = require('node:worker_threads');
    const fs = require('node:fs/promises');
    const original = fs.lstat;
    const counter = new Int32Array(workerData.counter);
    fs.lstat = async (...args) => { Atomics.add(counter, 0, 1); return original(...args); };
    require(workerData.workerPath);
  `,
    { counter }
  )
  const exit = once(worker, 'exit')
  const messages: ScannerWorkerMessage[] = []
  const first = once(worker, 'message')
  const receive = (raw: unknown): void => {
    const message = parseScannerWorkerMessage(raw, scanId)
    messages.push(message)
    if (message.type === 'batch' && message.sequence > 0) {
      worker.postMessage({ type: 'ack', scanId, sequence: message.sequence })
    }
  }
  worker.on('message', receive)
  await first
  const reads = Atomics.load(new Int32Array(counter), 0)
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(messages).toHaveLength(1)
  expect(Atomics.load(new Int32Array(counter), 0)).toBe(reads)
  worker.postMessage({ type: 'ack', scanId, sequence: 0 })
  expect(await exit).toEqual([0])
  const batches = messages.filter((message) => message.type === 'batch')
  expect(batches.map((batch) => batch.sequence)).toEqual([0, 1, 2])
  for (const batch of batches) expect(batch.events.length).toBeLessThanOrEqual(SCANNER_BATCH_SIZE)
  expect(batches.flatMap((batch) => batch.events).at(-1)?.type).toBe('summary')
  expect(messages.filter((message) => message.type === 'complete')).toHaveLength(1)
  worker.off('message', receive)
})

test('awaits consumer processing before acknowledging a batch', async () => {
  const worker = start()
  const messages: unknown[] = []
  const observe = (message: unknown): void => {
    messages.push(message)
  }
  worker.on('message', observe)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const consume = vi.fn(async () => {
    started()
    await gate
  })
  const result = consumeScannerWorker(worker, scanId, consume)
  await ready
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(consume).toHaveBeenCalledTimes(1)
  expect(messages).toHaveLength(1)
  release()
  await result
  expect(consume).toHaveBeenCalledTimes(3)
  worker.off('message', observe)
  expectReleased(worker)
})

test('reports cumulative progress once per batch and awaits slow progress before acknowledging', async () => {
  for (let index = 0; index < SCANNER_BATCH_SIZE * 2; index++) {
    await writeFile(join(rootPath, `file-${index}`), 'abc')
  }
  const worker = start()
  const acknowledge = vi.spyOn(worker, 'postMessage')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready!: () => void
  const firstProgress = new Promise<void>((resolve) => {
    ready = resolve
  })
  const snapshots: ScanProgress[] = []
  let consumedFiles = 0
  let consumedDirectories = 0
  let consumedBytes = 0
  let currentPath: string | null = null
  let receivedSummary = false
  const result = consumeScannerWorker(
    worker,
    scanId,
    async (event) => {
      // Progress must reflect even asynchronous consumer completion.
      await Promise.resolve()
      if (event.type === 'entry') {
        if (event.entry.type === 'file') {
          consumedFiles++
          consumedBytes += event.entry.sizeBytes ?? 0
        } else if (event.entry.type === 'directory') consumedDirectories++
      }
      if (event.type === 'entry' || event.type === 'directory-finalized')
        currentPath = event.entry.path
      if (event.type === 'summary') receivedSummary = true
    },
    async (snapshot) => {
      expect(snapshot).toEqual({
        scanId,
        processedFileCount: consumedFiles,
        processedDirectoryCount: consumedDirectories,
        processedBytes: consumedBytes,
        currentPath
      })
      snapshots.push(snapshot)
      if (snapshots.length === 1) {
        expect(receivedSummary).toBe(false)
        ready()
        await gate
      }
    }
  )
  try {
    await firstProgress
    expect(acknowledge).not.toHaveBeenCalled()
    expect(snapshots).toHaveLength(1)
    expect(consumedFiles).toBe(SCANNER_BATCH_SIZE - 1)
    expect(worker.threadId).toBeGreaterThan(0)
  } finally {
    release()
  }
  const completed = await result
  expect(snapshots.map((snapshot) => snapshot.processedFileCount)).toEqual([127, 255, 256])
  expect(snapshots.map((snapshot) => snapshot.processedBytes)).toEqual([381, 765, 768])
  expect(acknowledge).toHaveBeenCalledTimes(3)
  expect(snapshots.at(-1)).toEqual({
    scanId,
    processedFileCount: completed.summary.fileCount,
    processedDirectoryCount: completed.summary.directoryCount,
    processedBytes: completed.summary.totalBytes,
    currentPath: rootPath
  })
  expectReleased(worker)
})

test('reports known bytes with unknown file metadata and does not count junction targets', async (context) => {
  const target = await mkdtemp(join(suitePath, 'target-'))
  await writeFile(join(target, 'excluded'), 'not scanned')
  try {
    await symlink(target, join(rootPath, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip()
      return
    }
    throw error
  }
  await writeFile(join(rootPath, 'unknown'), 'unknown size')
  await writeFile(join(rootPath, 'known'), '12345')
  await writeFile(join(rootPath, 'empty'), '')
  const worker = start(
    `
    const { workerData } = require('node:worker_threads');
    const fs = require('node:fs/promises');
    const original = fs.lstat;
    fs.lstat = async (path, ...args) => {
      const stats = await original(path, ...args);
      if (path === workerData.unknown) stats.size = NaN;
      return stats;
    };
    require(workerData.workerPath);
  `,
    { unknown: join(rootPath, 'unknown') }
  )
  const progress = vi.fn()
  const events: ScanOutputEvent[] = []
  const result = await consumeScannerWorker(
    worker,
    scanId,
    (event) => {
      events.push(event)
    },
    progress
  )
  expect(events.filter((event) => event.type === 'error')).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: 'UNKNOWN_FILE_SIZE' }) })
  ])
  expect(result.summary).toEqual({ fileCount: 3, directoryCount: 1, totalBytes: 5, errorCount: 1 })
  expect(progress).toHaveBeenCalledExactlyOnceWith({
    scanId,
    processedFileCount: 3,
    processedDirectoryCount: 1,
    processedBytes: 5,
    currentPath: rootPath
  })
  expectReleased(worker)
})

test.each(['sync', 'async'] as const)(
  'terminates the worker when the %s progress consumer fails',
  async (kind) => {
    const worker = start()
    const acknowledge = vi.spyOn(worker, 'postMessage')
    const failure = new Error('Progress consumer failed')
    const progress = vi.fn(() => {
      if (kind === 'sync') throw failure
      return Promise.reject(failure)
    })
    await expect(consumeScannerWorker(worker, scanId, () => {}, progress)).rejects.toBe(failure)
    expect(progress).toHaveBeenCalledOnce()
    expect(acknowledge).not.toHaveBeenCalled()
    expectReleased(worker)
  }
)

test('rejects an inconsistent final summary before notifying progress', async () => {
  const worker = start(`
    const { parentPort, workerData } = require('node:worker_threads');
    const summary = { type: 'summary', scanId: workerData.scanId, rootEntryId: 'root',
      summary: { fileCount: 0, directoryCount: 1, totalBytes: 0, errorCount: 0 } };
    parentPort.postMessage({ type: 'batch', scanId: workerData.scanId, sequence: 0, events: [summary] });
    setInterval(() => {}, 1000);
  `)
  const progress = vi.fn()
  await expect(consumeScannerWorker(worker, scanId, () => {}, progress)).rejects.toThrow(
    'differs from'
  )
  expect(progress).not.toHaveBeenCalled()
  expectReleased(worker)
})

test('rejects a wrong acknowledgment and sends serializable fatal data', async () => {
  const worker = start()
  const exit = once(worker, 'exit')
  await once(worker, 'message')
  const fatal = once(worker, 'message')
  worker.postMessage({ type: 'ack', scanId: 'other-scan', sequence: 0 })
  const [message] = await fatal
  expect(message).toMatchObject({
    type: 'fatal',
    scanId,
    error: { name: 'Error', message: 'Invalid scanner batch acknowledgment.', code: null }
  })
  expect(message.error).not.toBeInstanceOf(Error)
  expect(JSON.parse(JSON.stringify(message))).toEqual(message)
  await exit
})

test.each([0, 7])('rejects unexpected exit code %s even without a runtime error', async (code) => {
  const worker = start(`process.exit(${code})`)
  await expect(consumeScannerWorker(worker, scanId, () => {})).rejects.toThrow(
    'exited unexpectedly'
  )
  expectReleased(worker)
})

test('propagates an uncaught worker exception and removes listeners', async () => {
  const worker = start(`throw new Error('Worker crashed')`)
  await expect(consumeScannerWorker(worker, scanId, () => {})).rejects.toThrow('Worker crashed')
  expectReleased(worker)
})

test.each(['sync', 'async'] as const)(
  'terminates the worker when the %s event consumer fails',
  async (kind) => {
    const worker = start()
    const failure = new Error('Consumer failed')
    const consume = vi.fn(() => {
      if (kind === 'sync') throw failure
      return Promise.reject(failure)
    })
    await expect(consumeScannerWorker(worker, scanId, consume)).rejects.toBe(failure)
    expect(consume).toHaveBeenCalledOnce()
    expectReleased(worker)
  }
)

test('handles a Main-side message decoding failure', async () => {
  const worker = start('setInterval(() => {}, 1000)')
  const failure = new Error('Cannot deserialize message')
  const result = consumeScannerWorker(worker, scanId, () => {})
  const assertion = expect(result).rejects.toBe(failure)
  worker.emit('messageerror', failure)
  await assertion
  expectReleased(worker)
})

test('handles an acknowledgment send failure without leaving the worker waiting', async () => {
  const worker = start()
  const failure = new Error('Cannot send acknowledgment')
  vi.spyOn(worker, 'postMessage').mockImplementation(() => {
    throw failure
  })
  await expect(consumeScannerWorker(worker, scanId, () => {})).rejects.toBe(failure)
  expectReleased(worker)
})

test.each([
  { type: 'complete', scanId },
  { type: 'complete', scanId: 'wrong-scan' },
  { type: 'batch', scanId, sequence: 0, events: [] },
  { type: 'batch', scanId, sequence: 0, events: [{ type: 'invalid' }] },
  {
    type: 'batch',
    scanId,
    sequence: 0,
    events: Array.from({ length: SCANNER_BATCH_SIZE + 1 }, () => ({
      type: 'error',
      error: { path: 'test', code: 'EIO', message: 'test' }
    }))
  }
])('rejects malformed or premature messages: $type', async (message) => {
  const worker = start(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.postMessage(workerData.message);
    setInterval(() => {}, 1000);
  `,
    { message }
  )
  await expect(consumeScannerWorker(worker, scanId, () => {})).rejects.toThrow()
  expectReleased(worker)
})

test('requires a normal exit after the final summary and completion message', async () => {
  const summary: ScanSummaryEvent = {
    type: 'summary',
    scanId,
    rootEntryId: 'root',
    summary: { fileCount: 0, directoryCount: 1, totalBytes: 0, errorCount: 0 }
  }
  const worker = start(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.once('message', () => {
      parentPort.postMessage({ type: 'complete', scanId: workerData.scanId });
      process.exitCode = 7;
      parentPort.close();
    });
    parentPort.postMessage({ type: 'batch', scanId: workerData.scanId, sequence: 0, events: [workerData.summary] });
  `,
    { summary }
  )
  await expect(consumeScannerWorker(worker, scanId, () => {})).rejects.toThrow('code 7')
  expectReleased(worker)
})

test('rejects messages that bypass backpressure', async () => {
  const worker = start(`
    const { parentPort, workerData } = require('node:worker_threads');
    const event = { type: 'error', error: { path: 'test', code: 'EIO', message: 'test' } };
    for (let sequence = 0; sequence < 2; sequence++) {
      parentPort.postMessage({ type: 'batch', scanId: workerData.scanId, sequence, events: [event] });
    }
    setInterval(() => {}, 1000);
  `)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await expect(consumeScannerWorker(worker, scanId, () => gate)).rejects.toThrow(
    'before batch acknowledgment'
  )
  release()
  expectReleased(worker)
})

test.each(['sequence', 'entry-scan', 'duplicate-complete', 'duplicate-summary'] as const)(
  'rejects protocol inconsistency: %s',
  async (fault) => {
    const worker = start(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const scanId = workerData.scanId;
      const summary = { type: 'summary', scanId, rootEntryId: 'root', summary: { fileCount: 0, directoryCount: 1, totalBytes: 0, errorCount: 0 } };
      if (workerData.fault === 'entry-scan') summary.scanId = 'another-scan';
      const events = workerData.fault === 'duplicate-summary' ? [summary, summary] : [summary];
      parentPort.on('message', () => {
        parentPort.postMessage({ type: 'complete', scanId });
        if (workerData.fault === 'duplicate-complete') parentPort.postMessage({ type: 'complete', scanId });
        parentPort.close();
      });
      parentPort.postMessage({ type: 'batch', scanId, sequence: workerData.fault === 'sequence' ? 1 : 0, events });
    `,
      { fault }
    )
    await expect(consumeScannerWorker(worker, scanId, () => {})).rejects.toThrow()
    expectReleased(worker)
  }
)
