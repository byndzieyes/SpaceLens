// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Dir } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { FileEntry, ScanError } from '../src/shared/scan'
import { basename, dirname, join, resolve } from 'node:path'
import {
  aggregateDirectorySizes,
  type ScannerAggregationEvent
} from '../src/main/scanner/aggregate'
import {
  traverseDirectory,
  traverseDirectoryEvents,
  type TraversalEvent
} from '../src/main/scanner/traverse'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, lstat: vi.fn(fs.lstat), opendir: vi.fn(fs.opendir) }
})

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const scanId = 'errors-test'
let fixturePath: string
let rootPath: string
let handles: Dir[]

async function openTracked(...args: Parameters<typeof opendir>): Promise<Dir> {
  const directory = await fs.opendir(...args)
  handles.push(directory)
  return directory
}

beforeEach(async () => {
  handles = []
  vi.mocked(lstat).mockImplementation(fs.lstat)
  vi.mocked(opendir).mockImplementation(openTracked)
  fixturePath = await fs.mkdtemp(join(tmpdir(), 'spacelens-errors-'))
  rootPath = join(fixturePath, 'root')
  await fs.mkdir(rootPath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  // Ensure even a failing test releases fixture handles before removing its data.
  for (const handle of handles) {
    try {
      await handle.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error
    }
  }
  const fixture = resolve(fixturePath)
  if (
    dirname(fixture) !== resolve(tmpdir()) ||
    !basename(fixture).startsWith('spacelens-errors-')
  ) {
    throw new Error('Refusing to remove a path outside the temporary test fixtures.')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Test filesystem failure: ${code}`), { code })
}

async function collect(
  source = traverseDirectoryEvents(rootPath, scanId)
): Promise<ScannerAggregationEvent[]> {
  const events: ScannerAggregationEvent[] = []
  for await (const event of aggregateDirectorySizes(source)) events.push(event)
  return events
}

function errors(events: ScannerAggregationEvent[]): ScanError[] {
  return events.filter((event) => event.type === 'error').map((event) => event.error)
}

function entries(events: ScannerAggregationEvent[]): FileEntry[] {
  return events.filter((event) => event.type === 'entry').map((event) => event.entry)
}

function totals(events: ScannerAggregationEvent[]): Record<string, number | null> {
  return Object.fromEntries(
    events
      .filter((event) => event.type === 'directory-finalized')
      .map(({ entry }) => [entry.path, entry.aggregatedSizeBytes])
  )
}

async function expectClosed(): Promise<void> {
  vi.restoreAllMocks()
  for (const handle of handles) {
    await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
  }
}

test.each(['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ESTALE', 'ENOTDIR'])(
  'reports %s metadata failures and keeps accessible siblings in the total',
  async (code) => {
    const bad = join(rootPath, 'bad')
    const good = join(rootPath, 'good')
    await fs.writeFile(bad, 'unknown data')
    await fs.writeFile(good, 'known')
    const failure = filesystemError(code)
    vi.mocked(lstat).mockImplementation(async (path, options) => {
      if (path === bad) throw failure
      return fs.lstat(path, options)
    })

    const events = await collect()
    expect(errors(events)).toEqual([{ path: bad, code, message: failure.message }])
    expect(JSON.parse(JSON.stringify(errors(events)))).toEqual(errors(events))
    expect(errors(events)[0]).not.toBeInstanceOf(Error)
    expect(
      entries(events)
        .map((entry) => entry.path)
        .sort()
    ).toEqual([rootPath, good].sort())
    expect(totals(events)).toEqual({ [rootPath]: 5 })
    await expectClosed()
  }
)

test('reports an inaccessible child directory, finalizes its known total and continues', async () => {
  const bad = join(rootPath, 'blocked')
  await fs.mkdir(bad)
  await fs.writeFile(join(bad, 'hidden'), 'not counted')
  await fs.writeFile(join(rootPath, 'good'), 'abc')
  vi.mocked(opendir).mockImplementation(async (path, options) => {
    if (path === bad) throw filesystemError('EACCES')
    return openTracked(path, options)
  })

  const events = await collect()
  expect(errors(events)).toEqual([
    { path: bad, code: 'EACCES', message: 'Test filesystem failure: EACCES' }
  ])
  expect(totals(events)).toEqual({ [rootPath]: 3, [bad]: 0 })
  expect(entries(events).find((entry) => entry.path === bad)).toMatchObject({
    type: 'directory',
    sizeBytes: null,
    aggregatedSizeBytes: null
  })
  expect(entries(events).some((entry) => entry.name === 'hidden')).toBe(false)
  await expectClosed()
})

test('retains files read before a child enumeration failure and visits unaffected siblings', async () => {
  const partial = join(rootPath, 'partial')
  const other = join(rootPath, 'other')
  await fs.mkdir(partial)
  await fs.mkdir(other)
  await fs.writeFile(join(partial, 'known'), '12345')
  await fs.writeFile(join(partial, 'unread'), 'not counted')
  await fs.writeFile(join(other, 'good'), '1234567')
  const child = (await fs.readdir(partial, { withFileTypes: true })).find(
    (item) => item.name === 'known'
  )!
  vi.mocked(opendir).mockImplementation(async (path, options) => {
    const directory = await openTracked(path, options)
    if (path === partial) {
      vi.spyOn(directory, 'read')
        .mockImplementationOnce(async () => child)
        .mockRejectedValueOnce(filesystemError('EIO'))
    }
    return directory
  })

  const events = await collect()
  expect(errors(events)).toEqual([
    { path: partial, code: 'EIO', message: 'Test filesystem failure: EIO' }
  ])
  expect(totals(events)).toEqual({ [rootPath]: 12, [partial]: 5, [other]: 7 })
  expect(entries(events).filter((entry) => entry.type === 'file')).toHaveLength(2)
  const discoveries = new Map(entries(events).map((entry) => [entry.id, entry]))
  for (const entry of discoveries.values()) {
    if (entry.parentId !== null) expect(discoveries.get(entry.parentId)?.type).toBe('directory')
  }
  await expectClosed()
})

test('recovers when a directory disappears after discovery but before opening', async () => {
  const gone = join(rootPath, 'gone')
  await fs.mkdir(gone)
  await fs.writeFile(join(rootPath, 'good'), 'ok')
  async function* changingSource(): AsyncGenerator<TraversalEvent> {
    for await (const event of traverseDirectoryEvents(rootPath, scanId)) {
      yield event
      if (event.type === 'entry' && event.entry.path === gone) await fs.rmdir(gone)
    }
  }
  const events = await collect(changingSource())
  expect(errors(events)).toEqual([expect.objectContaining({ path: gone, code: 'ENOENT' })])
  expect(totals(events)).toEqual({ [gone]: 0, [rootPath]: 2 })
  await expectClosed()
})

test('reports a directory becoming a file between enumeration and metadata retrieval', async () => {
  const changed = join(rootPath, 'changed')
  await fs.mkdir(changed)
  await fs.writeFile(join(rootPath, 'good'), 'abc')
  let replaced = false
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    if (path === changed && !replaced) {
      replaced = true
      await fs.rmdir(changed)
      await fs.writeFile(changed, '12345')
    }
    return fs.lstat(path, options)
  })
  const events = await collect()
  expect(errors(events)).toEqual([
    expect.objectContaining({ path: changed, code: 'ENTRY_TYPE_CHANGED' })
  ])
  expect(entries(events).find((entry) => entry.path === changed)).toMatchObject({
    type: 'file',
    sizeBytes: 5
  })
  expect(totals(events)).toEqual({ [rootPath]: 8 })
  await expectClosed()
})

test('does not enumerate a directory replaced by a file after its discovery was emitted', async () => {
  const changed = join(rootPath, 'changed')
  await fs.mkdir(changed)
  await fs.writeFile(join(rootPath, 'good'), 'ok')
  async function* changingSource(): AsyncGenerator<TraversalEvent> {
    for await (const event of traverseDirectoryEvents(rootPath, scanId)) {
      yield event
      if (event.type === 'entry' && event.entry.path === changed) {
        await fs.rmdir(changed)
        await fs.writeFile(changed, 'replacement not counted')
      }
    }
  }
  const events = await collect(changingSource())
  expect(errors(events)).toEqual([
    expect.objectContaining({ path: changed, code: 'ENTRY_CHANGED' })
  ])
  expect(totals(events)).toEqual({ [rootPath]: 2, [changed]: 0 })
  await expectClosed()
})

test('closes a directory if its post-open identity check fails', async () => {
  const changed = join(rootPath, 'changed')
  await fs.mkdir(changed)
  await fs.writeFile(join(rootPath, 'good'), 'abc')
  let opened = false
  vi.mocked(opendir).mockImplementation(async (path, options) => {
    const directory = await openTracked(path, options)
    if (path === changed) opened = true
    return directory
  })
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    if (path === changed && opened) throw filesystemError('ENOENT')
    return fs.lstat(path, options)
  })
  const events = await collect()
  expect(errors(events)).toEqual([expect.objectContaining({ path: changed, code: 'ENOENT' })])
  expect(totals(events)).toEqual({ [rootPath]: 3, [changed]: 0 })
  expect(handles).toHaveLength(2)
  await expectClosed()
})

test('does not follow a directory replaced by a link after discovery', async (context) => {
  const changed = join(rootPath, 'changed')
  const outside = join(fixturePath, 'outside')
  await fs.mkdir(changed)
  await fs.mkdir(outside)
  await fs.writeFile(join(outside, 'hidden'), 'not counted')
  const link = join(fixturePath, 'link')
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (
      ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      context.skip('Directory links are unavailable in this environment.')
    }
    throw error
  }
  async function* changingSource(): AsyncGenerator<TraversalEvent> {
    for await (const event of traverseDirectoryEvents(rootPath, scanId)) {
      yield event
      if (event.type === 'entry' && event.entry.path === changed) {
        await fs.rmdir(changed)
        await fs.rename(link, changed)
      }
    }
  }
  const events = await collect(changingSource())
  expect(errors(events)).toEqual([
    expect.objectContaining({ path: changed, code: 'ENTRY_CHANGED' })
  ])
  expect(entries(events).some((entry) => entry.name === 'hidden')).toBe(false)
  expect(totals(events)).toEqual({ [rootPath]: 0, [changed]: 0 })
  await expectClosed()
})

test('reports unknown logical sizes, preserves null metadata and sums known bytes', async () => {
  const unknown = join(rootPath, 'unknown')
  await fs.writeFile(unknown, 'unrepresentable')
  await fs.writeFile(join(rootPath, 'known'), 'abc')
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stats = await fs.lstat(path, options)
    return path === unknown ? Object.assign(stats, { size: NaN }) : stats
  })
  const events = await collect()
  expect(errors(events)).toEqual([
    expect.objectContaining({ path: unknown, code: 'UNKNOWN_FILE_SIZE' })
  ])
  expect(entries(events).find((entry) => entry.path === unknown)?.sizeBytes).toBeNull()
  expect(totals(events)).toEqual({ [rootPath]: 3 })
})

test('stops a child subtree if its identity changes during enumeration', async () => {
  const partial = join(rootPath, 'partial')
  const known = join(partial, 'known')
  await fs.mkdir(partial)
  await fs.writeFile(known, '12345')
  await fs.writeFile(join(partial, 'unread'), 'not counted')
  await fs.writeFile(join(rootPath, 'sibling'), 'abc')
  const child = (await fs.readdir(partial, { withFileTypes: true })).find(
    (item) => item.name === 'known'
  )!
  let changed = false
  vi.mocked(opendir).mockImplementation(async (path, options) => {
    const directory = await openTracked(path, options)
    if (path === partial) vi.spyOn(directory, 'read').mockImplementationOnce(async () => child)
    return directory
  })
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stats = await fs.lstat(path, options)
    if (path === partial && changed) return Object.assign(stats, { isDirectory: () => false })
    return stats
  })
  async function* changingSource(): AsyncGenerator<TraversalEvent> {
    for await (const event of traverseDirectoryEvents(rootPath, scanId)) {
      yield event
      if (event.type === 'entry' && event.entry.path === known) changed = true
    }
  }
  const events = await collect(changingSource())
  expect(errors(events)).toEqual([
    expect.objectContaining({ path: partial, code: 'ENTRY_CHANGED' })
  ])
  expect(totals(events)).toEqual({ [rootPath]: 8, [partial]: 5 })
  expect(entries(events).some((entry) => entry.name === 'unread')).toBe(false)
  await expectClosed()
})

test.each([new TypeError('Internal read failure'), filesystemError('EIO')])(
  'preserves the original failure and attempts all closes when cleanup also fails: %s',
  async (failure) => {
    const nested = join(rootPath, 'nested')
    await fs.mkdir(nested)
    const closeFailure = new Error('Close failure')
    vi.mocked(opendir).mockImplementation(async (path, options) => {
      const directory = await openTracked(path, options)
      if (path === nested) {
        vi.spyOn(directory, 'read').mockRejectedValue(failure)
        const close = directory.close.bind(directory)
        vi.spyOn(directory, 'close').mockImplementation(async () => {
          // Actually release the fixture handle before simulating a close failure.
          await new Promise<void>((resolve, reject) =>
            close((error) => (error ? reject(error) : resolve()))
          )
          throw closeFailure
        })
      }
      return directory
    })
    await expect(collect()).rejects.toMatchObject({ errors: [failure, closeFailure] })
    expect(handles).toHaveLength(2)
    await expectClosed()
  }
)

test.each(['metadata', 'open', 'read'] as const)(
  'root %s failures are fatal and release handles',
  async (operation) => {
    const failure = filesystemError('EACCES')
    if (operation === 'metadata') vi.mocked(lstat).mockRejectedValue(failure)
    if (operation === 'open') vi.mocked(opendir).mockRejectedValue(failure)
    if (operation === 'read') {
      vi.mocked(opendir).mockImplementation(async (...args) => {
        const directory = await openTracked(...args)
        vi.spyOn(directory, 'read').mockRejectedValue(failure)
        return directory
      })
    }
    const events: ScannerAggregationEvent[] = []
    await expect(async () => {
      for await (const event of aggregateDirectorySizes(traverseDirectoryEvents(rootPath, scanId)))
        events.push(event)
    }).rejects.toBe(failure)
    expect(
      events.some((event) => event.type === 'directory-finalized' || event.type === 'error')
    ).toBe(false)
    await expectClosed()
  }
)

test('invalid, missing and regular-file roots cannot produce successful scans', async () => {
  await fs.writeFile(join(rootPath, 'file'), '')
  await expect(collect(traverseDirectoryEvents('', scanId))).rejects.toThrow(
    'Root path must not be empty'
  )
  await expect(
    collect(traverseDirectoryEvents(join(rootPath, 'missing'), scanId))
  ).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(collect(traverseDirectoryEvents(join(rootPath, 'file'), scanId))).rejects.toThrow(
    'must be a directory'
  )
})

test.each([
  new TypeError('Programming error'),
  Object.assign(new TypeError('Programming error with code'), { code: 'EIO' }),
  new Error('Unexpected failure'),
  filesystemError('EMFILE'),
  filesystemError('EINVAL')
])('does not recover unexpected/internal failures: %s', async (failure) => {
  const bad = join(rootPath, 'bad')
  await fs.writeFile(bad, '')
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    if (path === bad) throw failure
    return fs.lstat(path, options)
  })
  await expect(collect()).rejects.toBe(failure)
  await expectClosed()
})

test('overflow remains fatal in the event pipeline and closes traversal handles', async () => {
  await fs.writeFile(join(rootPath, 'large'), '')
  await fs.writeFile(join(rootPath, 'extra'), '')
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stats = await fs.lstat(path, options)
    if (path === join(rootPath, 'large'))
      return Object.assign(stats, { size: Number.MAX_SAFE_INTEGER })
    if (path === join(rootPath, 'extra')) return Object.assign(stats, { size: 1 })
    return stats
  })
  await expect(collect()).rejects.toThrow(RangeError)
  await expectClosed()
})

test('yields an error incrementally and releases handles if its consumer stops there', async () => {
  const bad = join(rootPath, 'bad')
  await fs.writeFile(bad, '')
  await fs.writeFile(join(rootPath, 'later'), '')
  const child = (await fs.readdir(rootPath, { withFileTypes: true })).find(
    (item) => item.name === 'bad'
  )!
  const read = vi
    .fn()
    .mockResolvedValueOnce(child)
    .mockImplementation(() => {
      throw new Error('Read too far')
    })
  vi.mocked(opendir).mockImplementation(async (...args) => {
    const directory = await openTracked(...args)
    vi.spyOn(directory, 'read').mockImplementation(read)
    return directory
  })
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    if (path === bad) throw filesystemError('EPERM')
    return fs.lstat(path, options)
  })
  const iterator = aggregateDirectorySizes(traverseDirectoryEvents(rootPath, scanId))
  expect((await iterator.next()).value?.type).toBe('entry')
  expect(read).not.toHaveBeenCalled()
  expect((await iterator.next()).value).toMatchObject({
    type: 'error',
    error: { path: bad, code: 'EPERM' }
  })
  expect(read).toHaveBeenCalledOnce()
  await iterator.return()
  await expectClosed()
})

test('entry-only callers still fail instead of silently discarding recoverable errors', async () => {
  const bad = join(rootPath, 'bad')
  await fs.writeFile(bad, '')
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    if (path === bad) throw filesystemError('EACCES')
    return fs.lstat(path, options)
  })
  await expect(async () => {
    for await (const entry of traverseDirectory(rootPath, scanId))
      expect(entry.type).toBe('directory')
  }).rejects.toMatchObject({ code: 'EACCES', path: bad })
  await expectClosed()
})
