// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  aggregateDirectorySizes,
  type DirectoryAggregationEvent
} from '../src/main/scanner/aggregate'
import { traverseDirectory } from '../src/main/scanner/traverse'
import type { FileEntry } from '../src/shared/scan'

let fixturePath: string
let rootPath: string
const scanId = 'aggregation-test'

beforeEach(async () => {
  fixturePath = await mkdtemp(join(tmpdir(), 'spacelens-aggregation-'))
  rootPath = join(fixturePath, 'root')
  await mkdir(rootPath)
})

afterEach(async () => {
  const fixture = resolve(fixturePath)
  if (
    dirname(fixture) !== resolve(tmpdir()) ||
    !basename(fixture).startsWith('spacelens-aggregation-')
  ) {
    throw new Error('Refusing to remove a path outside the temporary test fixtures.')
  }
  await rm(fixture, { recursive: true, force: true })
})

async function collect(
  entries: AsyncIterable<FileEntry> = traverseDirectory(rootPath, scanId)
): Promise<DirectoryAggregationEvent[]> {
  const events: DirectoryAggregationEvent[] = []
  for await (const event of aggregateDirectorySizes(entries)) events.push(event)
  return events
}

function totals(events: DirectoryAggregationEvent[]): Record<string, number | null> {
  return Object.fromEntries(
    events
      .filter((event) => event.type === 'directory-finalized')
      .map(({ entry }) => [entry.path, entry.aggregatedSizeBytes])
  )
}

// Synthetic metadata is limited to tests for values impractical to create on disk.
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
    path: join(rootPath, id),
    name: id,
    type,
    sizeBytes,
    aggregatedSizeBytes: null,
    createdAt: null,
    modifiedAt: null
  })
}

async function* stream(...entries: FileEntry[]): AsyncGenerator<FileEntry> {
  yield* entries
}

test('finalizes an empty root as zero without changing its identity or discovery', async () => {
  const events = await collect()
  expect(events).toHaveLength(2)
  expect(events[0].type).toBe('entry')
  expect(events[0].entry.aggregatedSizeBytes).toBeNull()
  expect(events[1]).toEqual({
    type: 'directory-finalized',
    entry: { ...events[0].entry, aggregatedSizeBytes: 0 }
  })
  expect(events[1].entry.sizeBytes).toBeNull()
})

test.each([[50], [10, 20, 30], [0], [0, 5, 0]])(
  'aggregates regular file sizes %j including zero-byte files',
  async (...sizes) => {
    for (const [index, size] of sizes.entries()) {
      await writeFile(join(rootPath, `file-${index}`), Buffer.alloc(size))
    }
    const events = await collect()
    expect(totals(events)).toEqual({ [rootPath]: sizes.reduce((total, size) => total + size, 0) })
    const files = events.filter(({ entry }) => entry.type === 'file')
    expect(files).toHaveLength(sizes.length)
    for (const event of files) {
      expect(event.type).toBe('entry')
      expect(event.entry.aggregatedSizeBytes).toBeNull()
    }
  }
)

test('finalizes every nested directory once without double-counting descendant files', async () => {
  const nested = join(rootPath, 'nested')
  const deep = join(nested, 'deep')
  const empty = join(nested, 'empty')
  const sibling = join(rootPath, 'sibling')
  await mkdir(deep, { recursive: true })
  await mkdir(empty)
  await mkdir(sibling)
  await writeFile(join(rootPath, 'file.txt'), Buffer.alloc(50))
  await writeFile(join(nested, 'data.bin'), Buffer.alloc(100))
  await writeFile(join(deep, 'more.bin'), Buffer.alloc(25))
  await writeFile(join(sibling, 'last.bin'), Buffer.alloc(10))

  const events = await collect()
  expect(totals(events)).toEqual({
    [rootPath]: 185,
    [nested]: 125,
    [deep]: 25,
    [empty]: 0,
    [sibling]: 10
  })
  const discoveries = new Map<string, FileEntry>()
  const finalized = new Set<string>()
  for (const event of events) {
    if (event.type === 'entry') {
      if (event.entry.parentId !== null) {
        expect(discoveries.get(event.entry.parentId)?.type).toBe('directory')
      }
      discoveries.set(event.entry.id, event.entry)
    } else {
      expect(finalized.has(event.entry.id)).toBe(false)
      expect(event.entry).toEqual({
        ...discoveries.get(event.entry.id),
        aggregatedSizeBytes: totals(events)[event.entry.path]
      })
      expect(event.entry.type).toBe('directory')
      expect(event.entry.sizeBytes).toBeNull()
      expect(event.entry.scanId).toBe(scanId)
      expect(Number.isSafeInteger(event.entry.aggregatedSizeBytes)).toBe(true)
      finalized.add(event.entry.id)
    }
  }
  expect(finalized.size).toBe(5)
  expect(events.at(-1)?.entry.path).toBe(rootPath)
})

test('excludes directory-link targets and loops from the total', async (context) => {
  const outside = join(fixturePath, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'excluded.bin'), Buffer.alloc(100))
  await writeFile(join(rootPath, 'included.bin'), Buffer.alloc(7))
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, join(rootPath, 'external'), type)
    await symlink(rootPath, join(rootPath, 'loop'), type)
  } catch (error) {
    if (
      ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      context.skip('Directory links are unavailable in this environment.')
    }
    throw error
  }
  const events: DirectoryAggregationEvent[] = []
  for await (const event of aggregateDirectorySizes(traverseDirectory(rootPath, scanId))) {
    events.push(event)
    if (events.length > 5) break
  }
  expect(events).toHaveLength(5)
  expect(events.filter(({ entry }) => entry.type === 'symlink')).toHaveLength(2)
  expect(totals(events)).toEqual({ [rootPath]: 7 })
})

test('ignores symbolic links and special entries even if they carry a size', async () => {
  const root = entry('root', null, 'directory')
  const events = await collect(
    stream(root, entry('link', root.id, 'symlink', 100), entry('pipe', root.id, 'other', 200))
  )
  expect(totals(events)).toEqual({ [root.path]: 0 })
})

test('accepts the safe-integer boundary when adding a nested directory total', async () => {
  const root = entry('root', null, 'directory')
  const nested = entry('nested', root.id, 'directory')
  const events = await collect(
    stream(
      root,
      entry('direct', root.id, 'file', 1),
      nested,
      entry('large', nested.id, 'file', Number.MAX_SAFE_INTEGER - 1)
    )
  )
  expect(totals(events)).toEqual({
    [root.path]: Number.MAX_SAFE_INTEGER,
    [nested.path]: Number.MAX_SAFE_INTEGER - 1
  })
  expect(root.aggregatedSizeBytes).toBeNull()
  expect(nested.aggregatedSizeBytes).toBeNull()
})

test.each([false, true])(
  'rejects overflow from a file or nested directory (nested: %s)',
  async (nested) => {
    const root = entry('root', null, 'directory')
    const child = entry('child', root.id, 'directory')
    async function* entries(): AsyncGenerator<FileEntry> {
      yield root
      yield entry('large', root.id, 'file', Number.MAX_SAFE_INTEGER)
      if (nested) yield child
      yield entry('extra', nested ? child.id : root.id, 'file', 1)
    }
    const finalized: FileEntry[] = []
    await expect(async () => {
      for await (const event of aggregateDirectorySizes(entries())) {
        if (event.type === 'directory-finalized') finalized.push(event.entry)
      }
    }).rejects.toThrow(RangeError)
    expect(finalized).toEqual([])
  }
)

test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid input sizes (%s)',
  async (size) => {
    await expect(
      collect(stream(entry('root', null, 'directory'), entry('file', 'root', 'file', size)))
    ).rejects.toThrow(RangeError)
  }
)

test.each(['file', 'unknown'] as const)(
  'does not verify a total for an unknown %s size/type',
  async (type) => {
    const events: DirectoryAggregationEvent[] = []
    await expect(async () => {
      for await (const event of aggregateDirectorySizes(
        stream(entry('root', null, 'directory'), entry('unavailable', 'root', type))
      )) {
        events.push(event)
      }
    }).rejects.toThrow(/Cannot aggregate/)
    expect(events.map((event) => event.type)).toEqual(['entry'])
  }
)

test('produces discoveries and finalized subtrees before consuming the full source', async () => {
  const root = entry('root', null, 'directory')
  const child = entry('child', root.id, 'directory')
  const leaf = entry('leaf', child.id, 'file', 10)
  const sibling = entry('sibling', root.id, 'file', 5)
  let consumed = 0
  const closed = vi.fn()
  async function* entries(): AsyncGenerator<FileEntry> {
    try {
      for (const item of [root, child, leaf, sibling]) {
        consumed++
        yield item
      }
      throw new Error('Must not consume the rest before yielding the completed child.')
    } finally {
      closed()
    }
  }
  const iterator = aggregateDirectorySizes(entries())
  expect(consumed).toBe(0)
  expect((await iterator.next()).value).toEqual({ type: 'entry', entry: root })
  expect(consumed).toBe(1)
  expect((await iterator.next()).value).toEqual({ type: 'entry', entry: child })
  expect((await iterator.next()).value).toEqual({ type: 'entry', entry: leaf })
  expect((await iterator.next()).value).toEqual({
    type: 'directory-finalized',
    entry: { ...child, aggregatedSizeBytes: 10 }
  })
  expect(consumed).toBe(4)
  expect(closed).not.toHaveBeenCalled()
  await iterator.return()
  expect(closed).toHaveBeenCalledOnce()
})

test('propagates traversal failure without finalizing open ancestors', async () => {
  const failure = new Error('Traversal failed')
  async function* entries(): AsyncGenerator<FileEntry> {
    yield entry('root', null, 'directory')
    yield entry('file', 'root', 'file', 10)
    throw failure
  }
  const events: DirectoryAggregationEvent[] = []
  await expect(async () => {
    for await (const event of aggregateDirectorySizes(entries())) events.push(event)
  }).rejects.toBe(failure)
  expect(events.map((event) => event.type)).toEqual(['entry', 'entry'])
})

test('rejects missing parents and mixed scans instead of assigning incorrect totals', async () => {
  const root = entry('root', null, 'directory')
  await expect(collect(stream(entry('file', null, 'file', 1)))).rejects.toThrow('root directory')
  await expect(collect(stream(root, entry('orphan', 'missing', 'file', 1)))).rejects.toThrow(
    'active ancestor'
  )
  await expect(
    collect(stream(root, { ...entry('file', root.id, 'file', 1), scanId: 'different' }))
  ).rejects.toThrow('same scan')
})
