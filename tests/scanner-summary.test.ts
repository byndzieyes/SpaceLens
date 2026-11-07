// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Dir } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { FileEntry } from '../src/shared/scan'
import type { ScannerAggregationEvent } from '../src/main/scanner/aggregate'
import { scanDirectory } from '../src/main/scanner/scan'
import {
  summarizeScanEvents,
  type ScanOutputEvent,
  type ScanSummaryEvent
} from '../src/main/scanner/summary'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, lstat: vi.fn(fs.lstat) }
})

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const scanId = 'summary-test'
let rootPath: string

beforeEach(async () => {
  vi.mocked(lstat).mockImplementation(fs.lstat)
  rootPath = await fs.mkdtemp(join(tmpdir(), 'spacelens-summary-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  const fixture = resolve(rootPath)
  if (
    dirname(fixture) !== resolve(tmpdir()) ||
    !basename(fixture).startsWith('spacelens-summary-')
  ) {
    throw new Error('Refusing to remove a path outside the temporary test fixtures.')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

async function collect(
  source: AsyncIterable<ScanOutputEvent> = scanDirectory(rootPath, scanId)
): Promise<ScanOutputEvent[]> {
  const events: ScanOutputEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

function completed(events: ScanOutputEvent[]): ScanSummaryEvent {
  const summaries = events.filter((event) => event.type === 'summary')
  expect(summaries).toHaveLength(1)
  expect(events.at(-1)).toBe(summaries[0])
  return summaries[0]
}

function entry(
  id: string,
  parentId: string | null,
  type: FileEntry['type'],
  sizeBytes: number | null = null
): FileEntry {
  return Object.freeze({
    id,
    scanId,
    parentId,
    type,
    sizeBytes,
    name: id,
    path: id === 'root' ? rootPath : join(rootPath, id),
    aggregatedSizeBytes: null,
    createdAt: null,
    modifiedAt: null
  })
}

function discovery(entry: FileEntry): ScannerAggregationEvent {
  return { type: 'entry', entry }
}

function finalized(entry: FileEntry, bytes: number): ScannerAggregationEvent {
  return { type: 'directory-finalized', entry: { ...entry, aggregatedSizeBytes: bytes } }
}

async function* stream(
  ...events: ScannerAggregationEvent[]
): AsyncGenerator<ScannerAggregationEvent> {
  yield* events
}

test('summarizes an empty root and identifies its actual entry without claiming storage', async () => {
  const events = await collect()
  expect(events.map((event) => event.type)).toEqual(['entry', 'directory-finalized', 'summary'])
  const root = events[0]
  if (root.type !== 'entry') throw new Error('Expected root discovery')
  expect(completed(events)).toEqual({
    type: 'summary',
    scanId,
    rootEntryId: root.entry.id,
    summary: { fileCount: 0, directoryCount: 1, totalBytes: 0, errorCount: 0 }
  })
  expect(root.entry.parentId).toBeNull()
  expect(root.entry.path).toBe(rootPath)
})

test('counts nested discoveries once and sums files rather than directory totals', async () => {
  const nested = join(rootPath, 'nested')
  const deep = join(nested, 'deep')
  await fs.mkdir(deep, { recursive: true })
  await fs.mkdir(join(rootPath, 'empty'))
  await fs.writeFile(join(rootPath, 'first'), Buffer.alloc(10))
  await fs.writeFile(join(nested, 'second'), Buffer.alloc(20))
  await fs.writeFile(join(deep, 'third'), Buffer.alloc(30))
  await fs.writeFile(join(rootPath, 'zero'), '')
  const events = await collect()
  expect(completed(events).summary).toEqual({
    fileCount: 4,
    directoryCount: 4,
    totalBytes: 60,
    errorCount: 0
  })
  expect(events.filter((event) => event.type === 'directory-finalized')).toHaveLength(4)
  for (const event of events) {
    if (event.type === 'entry' || event.type === 'directory-finalized') {
      expect(event.entry.scanId).toBe(scanId)
    }
  }
})

test('counts a zero-byte file as a file with zero known bytes', async () => {
  await fs.writeFile(join(rootPath, 'zero'), '')
  expect(completed(await collect()).summary).toEqual({
    fileCount: 1,
    directoryCount: 1,
    totalBytes: 0,
    errorCount: 0
  })
})

test('reports 300 MB of known bytes and an error when private.dat is inaccessible', async () => {
  const first = join(rootPath, 'file1.txt')
  const second = join(rootPath, 'file2.txt')
  const denied = join(rootPath, 'private.dat')
  for (const path of [first, second, denied]) await fs.writeFile(path, '')
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    if (path === denied) throw Object.assign(new Error('Access denied'), { code: 'EACCES' })
    const stats = await fs.lstat(path, options)
    // Supply large logical metadata without creating large fixture files.
    if (path === first) return Object.assign(stats, { size: 100_000_000 })
    if (path === second) return Object.assign(stats, { size: 200_000_000 })
    return stats
  })
  const events = await collect()
  expect(completed(events).summary).toEqual({
    fileCount: 2,
    directoryCount: 1,
    totalBytes: 300_000_000,
    errorCount: 1
  })
  expect(events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', error: { path: denied, code: 'EACCES', message: 'Access denied' } }
  ])
})

test('counts discovered files with unknown sizes while keeping only known bytes and errors', async () => {
  const unknown = join(rootPath, 'unknown')
  await fs.writeFile(unknown, '')
  await fs.writeFile(join(rootPath, 'known'), 'abc')
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stats = await fs.lstat(path, options)
    return path === unknown ? Object.assign(stats, { size: NaN }) : stats
  })
  const events = await collect()
  expect(completed(events).summary).toEqual({
    fileCount: 2,
    directoryCount: 1,
    totalBytes: 3,
    errorCount: 1
  })
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'entry',
      entry: expect.objectContaining({ path: unknown, sizeBytes: null })
    })
  )
})

test('forwards source events unchanged and ignores non-regular entries in file and byte counts', async () => {
  const root = entry('root', null, 'directory')
  const input: ScannerAggregationEvent[] = [
    discovery(root),
    discovery(entry('link', 'root', 'symlink')),
    discovery(entry('pipe', 'root', 'other')),
    {
      type: 'error',
      error: { path: join(rootPath, 'unknown'), code: 'EIO', message: 'Unavailable' }
    },
    discovery(entry('unknown', 'root', 'unknown')),
    finalized(root, 0)
  ]
  const output = await collect(summarizeScanEvents(stream(...input), scanId))
  input.forEach((event, index) => expect(output[index]).toBe(event))
  expect(completed(output).summary).toEqual({
    fileCount: 0,
    directoryCount: 1,
    totalBytes: 0,
    errorCount: 1
  })
})

test.each(['root', 'child', 'finalized'] as const)(
  'rejects a different scan ID on %s events',
  async (where) => {
    const root = entry('root', null, 'directory')
    const wrongRoot = { ...root, scanId: 'other' }
    const input =
      where === 'root'
        ? [discovery(wrongRoot)]
        : where === 'child'
          ? [discovery(root), discovery({ ...entry('file', 'root', 'file', 1), scanId: 'other' })]
          : [discovery(root), finalized(wrongRoot, 0)]
    await expect(collect(summarizeScanEvents(stream(...input), scanId))).rejects.toThrow(
      'different scan'
    )
  }
)

test.each(['id', 'path', 'parentId'] as const)(
  'rejects a changed finalized root %s',
  async (field) => {
    const root = entry('root', null, 'directory')
    const changed = { ...root, [field]: 'changed' }
    await expect(
      collect(summarizeScanEvents(stream(discovery(root), finalized(changed, 0)), scanId))
    ).rejects.toThrow('root identity')
  }
)

test('rejects a second root discovery', async () => {
  const root = entry('root', null, 'directory')
  await expect(
    collect(summarizeScanEvents(stream(discovery(root), discovery(root)), scanId))
  ).rejects.toThrow('root discovery')
})

test('rejects empty or unfinished streams and events after root finalization', async () => {
  const root = entry('root', null, 'directory')
  for (const input of [[], [discovery(root)]]) {
    await expect(collect(summarizeScanEvents(stream(...input), scanId))).rejects.toThrow(
      'finalized root'
    )
  }
  await expect(collect(summarizeScanEvents(stream(finalized(root, 0)), scanId))).rejects.toThrow(
    'before root discovery'
  )
  await expect(
    collect(summarizeScanEvents(stream(discovery(entry('file', null, 'file', 0))), scanId))
  ).rejects.toThrow('First discovery')
  await expect(
    collect(
      summarizeScanEvents(stream(discovery(root), finalized(root, 0), finalized(root, 0)), scanId)
    )
  ).rejects.toThrow('after root finalization')
})

test('rejects mismatched root totals and unreported unknown metadata', async () => {
  const root = entry('root', null, 'directory')
  await expect(
    collect(
      summarizeScanEvents(
        stream(discovery(root), discovery(entry('file', 'root', 'file', 10)), finalized(root, 20)),
        scanId
      )
    )
  ).rejects.toThrow('known regular-file bytes')
  await expect(
    collect(
      summarizeScanEvents(
        stream(discovery(root), discovery(entry('file', 'root', 'file')), finalized(root, 0)),
        scanId
      )
    )
  ).rejects.toThrow('reported error')
})

test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects unsafe file and finalized directory sizes (%s)',
  async (value) => {
    const root = entry('root', null, 'directory')
    await expect(
      collect(
        summarizeScanEvents(
          stream(discovery(root), discovery(entry('file', 'root', 'file', value))),
          scanId
        )
      )
    ).rejects.toThrow(RangeError)
    await expect(
      collect(summarizeScanEvents(stream(discovery(root), finalized(root, value)), scanId))
    ).rejects.toThrow(RangeError)
  }
)

test('accepts the safe-integer boundary and detects summary arithmetic overflow', async () => {
  const root = entry('root', null, 'directory')
  const large = discovery(entry('large', 'root', 'file', Number.MAX_SAFE_INTEGER))
  const output = await collect(
    summarizeScanEvents(
      stream(
        discovery(root),
        large,
        discovery(entry('zero', 'root', 'file', 0)),
        finalized(root, Number.MAX_SAFE_INTEGER)
      ),
      scanId
    )
  )
  expect(completed(output).summary.totalBytes).toBe(Number.MAX_SAFE_INTEGER)
  await expect(
    collect(
      summarizeScanEvents(
        stream(discovery(root), large, discovery(entry('extra', 'root', 'file', 1))),
        scanId
      )
    )
  ).rejects.toThrow('totalBytes exceeds')
})

test('does not emit a summary if the source fails even after root finalization', async () => {
  const root = entry('root', null, 'directory')
  const failure = new Error('Late scanner failure')
  async function* source(): AsyncGenerator<ScannerAggregationEvent> {
    yield discovery(root)
    yield finalized(root, 0)
    throw failure
  }
  const output: ScanOutputEvent[] = []
  await expect(async () => {
    for await (const event of summarizeScanEvents(source(), scanId)) output.push(event)
  }).rejects.toBe(failure)
  expect(output.map((event) => event.type)).toEqual(['entry', 'directory-finalized'])
})

test('propagates fatal root failures without fabricating root information or a summary', async () => {
  const output: ScanOutputEvent[] = []
  await expect(async () => {
    for await (const event of scanDirectory(join(rootPath, 'missing'), scanId)) output.push(event)
  }).rejects.toMatchObject({ code: 'ENOENT' })
  expect(output).toEqual([])
})

test('processes a wide stream incrementally without collecting its entries', async () => {
  const root = entry('root', null, 'directory')
  const width = 2_000
  let produced = 0
  let exhausted = false
  async function* source(): AsyncGenerator<ScannerAggregationEvent> {
    yield discovery(root)
    for (let index = 0; index < width; index++) {
      produced++
      yield discovery(entry(`file-${index}`, 'root', 'file', 1))
    }
    yield finalized(root, width)
    exhausted = true
  }
  let consumed = 0
  let summaries = 0
  for await (const event of summarizeScanEvents(source(), scanId)) {
    if (event.type === 'entry' && event.entry.type === 'file') {
      consumed++
      expect(produced).toBe(consumed)
      expect(exhausted).toBe(false)
    } else if (event.type === 'summary') {
      summaries++
      expect(exhausted).toBe(true)
      expect(event.summary).toEqual({
        fileCount: width,
        directoryCount: 1,
        totalBytes: width,
        errorCount: 0
      })
    }
  }
  expect(consumed).toBe(width)
  expect(summaries).toBe(1)
})

test('early consumer exit closes the composed traversal without producing a summary', async () => {
  const close = vi.spyOn(Dir.prototype, 'close')
  const iterator = scanDirectory(rootPath, scanId)
  expect((await iterator.next()).value?.type).toBe('entry')
  expect(await iterator.return()).toEqual({ done: true, value: undefined })
  const handles = new Set(close.mock.contexts)
  expect(handles.size).toBe(1)
  for (const handle of handles) {
    if (!(handle instanceof Dir)) throw new Error('Expected a directory handle')
    await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
  }
})
