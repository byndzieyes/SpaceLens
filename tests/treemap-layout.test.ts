import { expect, test } from 'vitest'
import {
  createTreemapData,
  treemapItemKey
} from '../src/renderer/src/features/explorer/treemapData'
import { calculateTreemap } from '../src/renderer/src/features/explorer/treemapLayout'
import {
  treemapFile as file,
  treemapFolder as folder,
  treemapRoot as root
} from './treemap-fixtures'

test('uses logical file and finalized directory sizes exactly once while preserving identity and API order', () => {
  const entries = [
    { ...file, aggregatedSizeBytes: 99999 },
    { ...folder, sizeBytes: 99999 }
  ]
  const data = createTreemapData(root, entries)
  expect(data.directory).toBe(root)
  expect(data.totalBytes).toBe(4000)
  expect(data.children.map((child) => child.bytes)).toEqual([1000, 3000])
  expect(data.children.map((child) => child.entry)).toEqual(entries)
  expect(createTreemapData(root, entries)).toEqual(data)
  calculateTreemap(data, 640, 320)
  expect(data.children.map((child) => child.entry.id)).toEqual(['file', 'folder'])
})

test('keeps known zero separate from unavailable metadata and never infers symbolic-link sizes', () => {
  const data = createTreemapData(root, [
    { ...file, sizeBytes: 0 },
    { ...folder, aggregatedSizeBytes: null },
    ...(['symlink', 'other', 'unknown'] as const).map((type) => ({
      ...file,
      id: type,
      type,
      sizeBytes: 9000
    }))
  ])
  expect(data.children.map((item) => item.bytes)).toEqual([0, null, null, null, null])
  expect(data).toMatchObject({ totalBytes: 0, zeroCount: 1, unknownCount: 4 })
  expect(calculateTreemap(data, 640, 320)).toEqual([])
})

test.each([-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  'excludes invalid byte count %s',
  (bytes) => {
    const data = createTreemapData(root, [{ ...file, sizeBytes: bytes }])
    expect(data).toMatchObject({ totalBytes: 0, zeroCount: 0, unknownCount: 1 })
  }
)

test('rejects nested/foreign/duplicate entries and unsafe total sizes', () => {
  expect(() => createTreemapData(root, [{ ...file, parentId: 'folder' }])).toThrow(
    /direct children/
  )
  expect(() => createTreemapData(root, [{ ...file, scanId: 'old' }])).toThrow(/snapshot/)
  expect(() => createTreemapData(root, [file, file])).toThrow(/distinct/)
  expect(() => createTreemapData(file, [])).toThrow(/root/)
  expect(() =>
    createTreemapData(root, [{ ...file, sizeBytes: Number.MAX_SAFE_INTEGER }, folder])
  ).toThrow(/byte total/)
})

test('D3 areas are proportional to known bytes with no root or descendant double-counting', () => {
  const data = createTreemapData(root, [file, folder])
  const rectangles = calculateTreemap(data, 600, 400, 0)
  expect(rectangles.map((rect) => treemapItemKey(rect.item))).toEqual(['folder', 'file'])
  const area = (id: string): number => {
    const rect = rectangles.find((rect) => treemapItemKey(rect.item) === id)!
    return rect.width * rect.height
  }
  expect(area('folder') / area('file')).toBeCloseTo(3, 8)
  expect(area('folder') + area('file')).toBeCloseTo(600 * 400, 8)
  expect(calculateTreemap(data, 600, 400, 0)).toEqual(rectangles)
})

test.each([
  [280, 256],
  [400, 320],
  [900, 480],
  [1280, 640],
  [1, 1]
])('geometry stays finite and bounded at %s × %s', (width, height) => {
  const data = createTreemapData(
    root,
    Array.from({ length: 100 }, (_, i) => ({ ...file, id: `file-${i}`, sizeBytes: i + 1 }))
  )
  for (const rect of calculateTreemap(data, width, height)) {
    for (const value of [rect.x, rect.y, rect.width, rect.height]) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(rect.x + rect.width).toBeLessThanOrEqual(width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(height)
  }
})

test('zero and unknown entries do not acquire visible area, even beside large values', () => {
  const data = createTreemapData(root, [
    file,
    { ...folder, aggregatedSizeBytes: 0 },
    { ...file, id: 'unknown', sizeBytes: null },
    { ...file, id: 'big', sizeBytes: Number.MAX_SAFE_INTEGER - 1000 }
  ])
  expect(calculateTreemap(data, 640, 320).map((rect) => treemapItemKey(rect.item))).toEqual([
    'big',
    'file'
  ])
})

test.each([
  [0, 200],
  [-1, 200],
  [NaN, 200],
  [400, Infinity],
  [Number.MAX_VALUE, Number.MAX_VALUE]
])('invalid dimensions %s × %s produce no invalid geometry', (width, height) => {
  expect(calculateTreemap(createTreemapData(root, [file]), width, height)).toEqual([])
})

test('empty and all-zero layouts have no rectangles', () => {
  expect(calculateTreemap(createTreemapData(root, []), 640, 320)).toEqual([])
  expect(calculateTreemap(createTreemapData(root, [{ ...file, sizeBytes: 0 }]), 640, 320)).toEqual(
    []
  )
})

test('Other gets proportional area for its known sizes and has no area when all grouped sizes are zero or unknown', () => {
  const other = { count: 4, knownBytes: 3000, unknownCount: 2, zeroCount: 1 }
  const data = createTreemapData(root, [file], other)
  expect(data).toMatchObject({ totalBytes: 4000, unknownCount: 2, zeroCount: 1 })
  for (const width of [400, 900, 1280]) {
    const [grouped, individual] = calculateTreemap(data, width, 320, 0)
    expect(grouped.item).toMatchObject({ kind: 'other', aggregate: other })
    expect((grouped.width * grouped.height) / (individual.width * individual.height)).toBeCloseTo(3)
    expect(grouped.x + grouped.width).toBeLessThanOrEqual(width)
    expect(grouped.y + grouped.height).toBeLessThanOrEqual(320)
  }
  const zero = createTreemapData(root, [file], { ...other, knownBytes: 0, zeroCount: 2 })
  expect(calculateTreemap(zero, 640, 320).map(({ item }) => item.kind)).toEqual(['entry'])
  expect(() =>
    createTreemapData(root, [file], { ...other, knownBytes: Number.MAX_SAFE_INTEGER })
  ).toThrow(/byte total/)
})
