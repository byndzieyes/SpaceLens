// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { scanDirectory } from '../src/main/scanner/scan'
import { consumeScannerWorker } from '../src/main/scanner/workerClient'
import {
  SCANNER_BATCH_SIZE,
  parseScannerWorkerMessage,
  type ScannerWorkerMessage
} from '../src/main/scanner/workerProtocol'
import type { ScanOutputEvent, ScanSummaryEvent } from '../src/main/scanner/summary'
import type { runScannerWorker } from '../src/main/scanner/workerRunner'

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

function start(script?: string, extra: Record<string, unknown> = {}): Worker {
  const worker = new Worker(script ?? workerPath, {
    eval: script !== undefined,
    workerData: { rootPath, scanId, workerPath, ...extra }
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

test.each(['development', 'production'])(
  'launches the generated %s runner/worker from relocated JavaScript artifacts',
  async (mode) => {
    const events: ScanOutputEvent[] = []
    const result = await artifacts.get(mode)!.runner(rootPath, scanId, (event) => {
      events.push(event)
    })
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
  const summary = await consumeScannerWorker(worker, scanId, (event) => {
    events.push(event)
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
  const result = await consumeScannerWorker(worker, scanId, (event) => {
    events.push(event)
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
  await expect(consumeScannerWorker(worker, scanId, consume)).rejects.toMatchObject({
    code: 'ENOENT'
  })
  expect(consume).not.toHaveBeenCalled()
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
  await expect(
    consumeScannerWorker(worker, scanId, (event) => {
      events.push(event)
    })
  ).rejects.toMatchObject({ name: 'TypeError', message: 'Unexpected scanner failure' })
  expect(events.map((event) => event.type)).toEqual(['entry'])
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
