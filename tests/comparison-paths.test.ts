// @vitest-environment node

import { expect, test } from 'vitest'
import {
  comparisonPathKey,
  findComparisonPathCollision,
  normalizeComparisonRoot
} from '../src/main/comparison/paths'
import { bindFilesystemText } from '../src/main/storage/filesystemText'

function file(
  path: string,
  id = 'file',
  parentId = 'root'
): { path: string; id: string; parentId: string; type: 'file' } {
  return { path, id, parentId, type: 'file' }
}

test('matches entries independently of their IDs and separates same-named files by full path', () => {
  const from = comparisonPathKey('/root', file('/root/deep/item', 'old'), 'posix')
  const to = comparisonPathKey('/root', file('/root/deep/item', 'new', 'different-parent'), 'posix')
  expect(from).toBe('deep/item')
  expect(to).toBe(from)
  expect(comparisonPathKey('/root', file('/root/other/item'), 'posix')).toBe('other/item')
})

test.each([
  ['/root/', '/root', 'posix'],
  ['/', '/', 'posix'],
  ['C:\\', 'c:/', 'win32'],
  ['\\\\Server\\Share', '//Server/Share/', 'win32']
] as const)('reserves the empty key for the %s root directory', (root, path, style) => {
  expect(comparisonPathKey(root, { path, parentId: null, type: 'directory' }, style)).toBe('')
  expect(comparisonPathKey(root, { path, parentId: 'parent', type: 'directory' }, style)).toBeNull()
  expect(comparisonPathKey(root, { path, parentId: null, type: 'file' }, style)).toBeNull()
})

test('preserves case and Unicode code units including POSIX backslashes', () => {
  const paths = [
    'Name.txt',
    'name.txt',
    'é',
    'e\u0301',
    '資料/🧭',
    'dir\\child',
    'dir/child',
    '\ud800'
  ]
  const keys = paths.map((path) => comparisonPathKey('/root', file('/root/' + path), 'posix'))
  expect(keys).toEqual(paths)
  expect(new Set(keys).size).toBe(paths.length)
})

test('normalizes Windows separators and drive letters, preserving every component', () => {
  expect(comparisonPathKey('C:\\', file('c:/Archive\\資料/File.TXT'), 'win32')).toBe(
    'Archive/資料/File.TXT'
  )
  expect(comparisonPathKey('c:\\Root', file('C:/root/File.TXT'), 'win32')).toBeNull()
  expect(comparisonPathKey('C:\\Root', file('D:\\Root\\File.TXT'), 'win32')).toBeNull()
  expect(
    comparisonPathKey('\\\\Server\\Share\\', file('//Server/Share\\Dir/Name.txt'), 'win32')
  ).toBe('Dir/Name.txt')
  expect(
    comparisonPathKey('\\\\Server\\Share', file('\\\\Server\\Share2\\Name.txt'), 'win32')
  ).toBeNull()
})

test.each([
  'root/file',
  '/rooted/file',
  '/root/../root/file',
  '/root/deep/../../outside',
  '/root/./file',
  '/root//file',
  '/root/file/',
  '/root/\0file'
])('rejects invalid or escaping POSIX entry %s', (path) => {
  expect(comparisonPathKey('/root', file(path), 'posix')).toBeNull()
})

test.each([
  'C:root\\file',
  '\\root\\file',
  'C:\\root\\..\\root\\file',
  'C:\\root\\\\file',
  'C:\\root\\file:alternate',
  'C:\\root\\file. ',
  'C:\\root\\CON.txt',
  '\\\\?\\C:\\root\\file'
])('rejects invalid or ambiguous Windows entry %s', (path) => {
  expect(comparisonPathKey('C:\\root', file(path), 'win32')).toBeNull()
})

test.each([
  ['//ambiguous/share', 'posix'],
  ['relative', 'posix'],
  ['/root/./alias', 'posix'],
  ['C:', 'win32'],
  ['\\root', 'win32'],
  ['\\\\Server', 'win32'],
  ['\\\\Server\\\\Share', 'win32'],
  ['\\\\.\\pipe\\root', 'win32']
] as const)('rejects unsupported root spelling %s', (root, style) => {
  expect(normalizeComparisonRoot(root, style)).toBeNull()
})

test('detects duplicate keys from separator aliases and duplicate roots within a snapshot', () => {
  const keys = [
    comparisonPathKey('C:\\', file('C:\\Dir\\file', 'one'), 'win32')!,
    comparisonPathKey('C:\\', file('c:/Dir/file', 'two'), 'win32')!
  ]
  expect(keys).toEqual(['Dir/file', 'Dir/file'])
  expect(findComparisonPathCollision(keys.sort())).toBe('Dir/file')
  expect(findComparisonPathCollision(['', '', 'A', 'a'])).toBe('')
  expect(findComparisonPathCollision(['', 'A', 'a', 'e\u0301', 'é'])).toBeNull()
})

test('the existing UTF-16 BLOB encoding keeps key equality and ordering lossless', () => {
  const keys = ['', 'A', 'a', 'e\u0301', 'é', '\ud800', '🧭', '\uffff', 'dir\\child', 'dir/child']
  expect(new Set(keys.map((key) => bindFilesystemText(key).toString('hex'))).size).toBe(keys.length)
  expect(
    [...keys].sort((left, right) =>
      Buffer.compare(bindFilesystemText(left), bindFilesystemText(right))
    )
  ).toEqual([...keys].sort())
})
