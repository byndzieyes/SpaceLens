// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Dir } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createFileEntry } from '../src/main/scanner/fileEntry'
import { traverseDirectory } from '../src/main/scanner/traverse'
import type { FileEntry } from '../src/shared/scan'

let fixturePath: string
let rootPath: string
const scanId = 'test-scan'

beforeEach(async () => {
  fixturePath = await mkdtemp(join(tmpdir(), 'spacelens-traversal-'))
  rootPath = join(fixturePath, 'root')
  await mkdir(rootPath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  // Only remove the unique fixture directory under the OS temporary directory.
  const fixture = resolve(fixturePath)
  if (
    dirname(fixture) !== resolve(tmpdir()) ||
    !basename(fixture).startsWith('spacelens-traversal-')
  ) {
    throw new Error('Refusing to remove a path outside the temporary test fixtures.')
  }
  await rm(fixture, { recursive: true, force: true })
})

async function collect(path = rootPath): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  for await (const entry of traverseDirectory(path, scanId)) entries.push(entry)
  return entries
}

test('emits an empty root with absolute path, nullable sizes and ISO timestamps', async () => {
  const entries = await collect(relative(process.cwd(), rootPath))
  const stats = await lstat(rootPath)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toEqual({
    id: expect.any(String),
    scanId,
    parentId: null,
    path: rootPath,
    name: 'root',
    type: 'directory',
    sizeBytes: null,
    aggregatedSizeBytes: null,
    createdAt: new Date(stats.birthtimeMs).toISOString(),
    modifiedAt: new Date(stats.mtimeMs).toISOString()
  })
})

test('emits regular files with logical byte sizes and preserves their contents', async () => {
  const contents = Buffer.from('Привіт, Space Lens!')
  await writeFile(join(rootPath, 'notes.txt'), contents)
  await writeFile(join(rootPath, 'empty.txt'), '')
  const entries = await collect()
  const files = entries.filter((entry) => entry.type === 'file')
  expect(files).toHaveLength(2)
  expect(files.find((entry) => entry.name === 'notes.txt')?.sizeBytes).toBe(contents.byteLength)
  expect(files.find((entry) => entry.name === 'empty.txt')?.sizeBytes).toBe(0)
  for (const file of files) {
    expect(file.parentId).toBe(entries[0].id)
    expect(file.scanId).toBe(scanId)
    expect(file.aggregatedSizeBytes).toBeNull()
    expect(Number.isSafeInteger(file.sizeBytes)).toBe(true)
    expect(file.sizeBytes).toBeGreaterThanOrEqual(0)
    expect(file.createdAt).toMatch(/Z$/)
    expect(file.modifiedAt).toMatch(/Z$/)
  }
  expect(await readFile(join(rootPath, 'notes.txt'))).toEqual(contents)
})

test('emits every parent before its children across nested and sibling directories', async () => {
  const nested = join(rootPath, 'Каталог з пробілами', '資料', 'level three')
  await mkdir(nested, { recursive: true })
  await mkdir(join(rootPath, 'sibling'))
  await writeFile(join(nested, 'résumé 😀.txt'), 'abc')
  await writeFile(join(rootPath, 'sibling', 'second.txt'), 'def')

  const entries = await collect()
  expect(entries).toHaveLength(7)
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
  const emitted = new Map<string, FileEntry>()
  for (const entry of entries) {
    expect(isAbsolute(entry.path)).toBe(true)
    expect(entry.scanId).toBe(scanId)
    expect(entry.aggregatedSizeBytes).toBeNull()
    if (entry.type === 'directory') expect(entry.sizeBytes).toBeNull()
    if (entry.parentId !== null) {
      const parent = emitted.get(entry.parentId)
      expect(parent?.type).toBe('directory')
      expect(parent?.path).toBe(dirname(entry.path))
    } else {
      expect(entry.path).toBe(rootPath)
    }
    emitted.set(entry.id, entry)
  }
  expect(entries.find((entry) => entry.path === join(nested, 'résumé 😀.txt'))).toMatchObject({
    name: 'résumé 😀.txt',
    type: 'file',
    sizeBytes: 3
  })
})

test('handles deep nesting without recursive generator calls', async () => {
  let nested = rootPath
  for (let depth = 0; depth < 40; depth++) {
    nested = join(nested, 'd')
    await mkdir(nested)
  }
  await writeFile(join(nested, 'leaf'), 'x')
  expect(await collect()).toHaveLength(42)
})

test('does not follow directory links outside the root or loops back to the root', async (context) => {
  const outside = join(fixturePath, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'must-not-be-emitted.txt'), 'secret')
  try {
    // Junctions allow this test to run on Windows without symlink privileges.
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, join(rootPath, 'external link'), type)
    await symlink(rootPath, join(rootPath, 'loop'), type)
  } catch (error) {
    if (
      ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      context.skip('Directory links are unavailable in this environment.')
    }
    throw error
  }

  // Bound the test itself so a traversal regression cannot run indefinitely.
  const entries: FileEntry[] = []
  for await (const entry of traverseDirectory(rootPath, scanId)) {
    entries.push(entry)
    if (entries.length > 3) break
  }
  expect(entries).toHaveLength(3)
  expect(
    entries
      .slice(1)
      .map((entry) => entry.name)
      .sort()
  ).toEqual(['external link', 'loop'])
  for (const entry of entries.slice(1)) {
    expect(entry).toMatchObject({
      type: 'symlink',
      parentId: entries[0].id,
      sizeBytes: null,
      aggregatedSizeBytes: null
    })
  }
  await expect(collect(join(rootPath, 'external link') + sep)).rejects.toThrow(
    'must be a directory'
  )
})

test('emits file and dangling symlinks without reading their targets', async (context) => {
  const target = join(fixturePath, 'target.txt')
  await writeFile(target, 'outside')
  try {
    await symlink(target, join(rootPath, 'file link'), 'file')
    await symlink(join(fixturePath, 'missing'), join(rootPath, 'dangling link'), 'file')
  } catch (error) {
    if (
      ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      context.skip('File symlinks are unavailable in this environment.')
    }
    throw error
  }
  const entries = await collect()
  expect(entries).toHaveLength(3)
  expect(
    entries.slice(1).every((entry) => entry.type === 'symlink' && entry.sizeBytes === null)
  ).toBe(true)
})

test('rejects nonexistent roots, regular-file roots and empty inputs', async () => {
  await expect(collect(join(rootPath, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  const file = join(rootPath, 'file.txt')
  await writeFile(file, '')
  await expect(collect(file)).rejects.toThrow('must be a directory')
  await expect(collect('')).rejects.toThrow('Root path must not be empty')
  await expect(traverseDirectory(rootPath, ' ').next()).rejects.toThrow('Scan ID must not be empty')
})

test('is lazy and releases open directory handles when the consumer stops early', async () => {
  await mkdir(join(rootPath, 'child'))
  await writeFile(join(rootPath, 'child', 'leaf.txt'), 'x')
  const read = vi.spyOn(Dir.prototype, 'read')
  const close = vi.spyOn(Dir.prototype, 'close')
  const iterator = traverseDirectory(rootPath, scanId)
  expect(read).not.toHaveBeenCalled()
  expect((await iterator.next()).value).toMatchObject({ path: rootPath })
  expect(read).not.toHaveBeenCalled()
  expect((await iterator.next()).value).toMatchObject({ name: 'child' })
  expect((await iterator.next()).value).toMatchObject({ name: 'leaf.txt' })
  expect(read).toHaveBeenCalledTimes(2)
  await iterator.return()
  // Node's promise-based close can call its callback overload internally.
  const handles = new Set(close.mock.contexts)
  expect(handles.size).toBe(2)
  for (const handle of handles) {
    if (!(handle instanceof Dir)) throw new Error('Expected a directory handle.')
    await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
  }
})

test('propagates read errors and releases directory handles', async () => {
  const failure = Object.assign(new Error('Cannot read directory'), { code: 'EACCES' })
  vi.spyOn(Dir.prototype, 'read').mockRejectedValueOnce(failure)
  const close = vi.spyOn(Dir.prototype, 'close')
  await expect(collect()).rejects.toBe(failure)
  const handles = new Set(close.mock.contexts)
  expect(handles.size).toBe(1)
  for (const handle of handles) {
    if (!(handle instanceof Dir)) throw new Error('Expected a directory handle.')
    await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
  }
})

test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'represents an unrepresentable logical file size (%s) as null',
  async (size) => {
    const path = join(rootPath, 'file')
    await writeFile(path, '')
    const stats = Object.assign(await lstat(path), { size })
    expect(createFileEntry(path, scanId, 'parent', stats).sizeBytes).toBeNull()
  }
)

test.each([0, 1, Number.MAX_SAFE_INTEGER])(
  'preserves a safe logical file size (%s)',
  async (size) => {
    const path = join(rootPath, 'file')
    await writeFile(path, '')
    const stats = Object.assign(await lstat(path), { size })
    expect(createFileEntry(path, scanId, 'parent', stats).sizeBytes).toBe(size)
  }
)

test('represents unavailable timestamps as null and classifies special entries as other', async () => {
  const stats = await lstat(rootPath)
  vi.spyOn(stats, 'isDirectory').mockReturnValue(false)
  Object.assign(stats, { birthtimeMs: NaN, mtimeMs: Infinity })
  expect(createFileEntry(rootPath, scanId, null, stats)).toMatchObject({
    type: 'other',
    sizeBytes: null,
    aggregatedSizeBytes: null,
    createdAt: null,
    modifiedAt: null
  })
})
