// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { buildObservations } from '../src/main/insights/observations'
import {
  INSIGHTS_OBSERVATION_TYPES,
  INSIGHTS_SIZE_BUCKETS,
  type InsightsRankedEntry
} from '../src/shared/insights'

function observations(
  sizes: readonly (number | null)[],
  {
    errorCount = 0,
    imageBytes = 0,
    directoryBytes = []
  }: { errorCount?: number; imageBytes?: number; directoryBytes?: readonly number[] } = {}
): ReturnType<typeof buildObservations> {
  const scanId = 'saved'
  const buckets = INSIGHTS_SIZE_BUCKETS.map(({ id, minBytes }, index) => {
    const max = INSIGHTS_SIZE_BUCKETS[index + 1]?.minBytes ?? Infinity
    const members = sizes.filter(
      (size): size is number => size !== null && size >= minBytes && size < max
    )
    return {
      id,
      fileCount: members.length,
      knownBytes: members.reduce((sum, size) => sum + size, 0)
    }
  })
  const knownBytes = buckets.reduce((sum, row) => sum + row.knownBytes, 0)
  const unknownSizeCount = sizes.filter((size) => size === null).length
  const totals = { fileCount: sizes.length, knownBytes, unknownSizeCount }
  const incomplete = errorCount > 0 || unknownSizeCount > 0
  const entries = (
    type: InsightsRankedEntry['type'],
    sizes: readonly (number | null)[]
  ): InsightsRankedEntry[] =>
    sizes
      .toSorted((left, right) => (right ?? -1) - (left ?? -1))
      .map((bytes, index) => ({
        scanId,
        id: `${type}-${index}`,
        parentId: 'root',
        type,
        name: `item-${index}`,
        path: `/fixture/item-${index}`,
        bytes
      }))
  return buildObservations(
    {
      scanId,
      summary: { errorCount, totalBytes: knownBytes, fileCount: sizes.length, directoryCount: 3 }
    },
    { scanId, incomplete, totals, knownSizeCount: sizes.length - unknownSizeCount, buckets },
    () => ({
      categories: {
        scanId,
        incomplete,
        totals,
        categories: [
          { category: 'images', fileCount: 1, unknownSizeCount: 0, knownBytes: imageBytes },
          {
            category: 'other',
            fileCount: Math.max(0, sizes.length - 1),
            unknownSizeCount,
            knownBytes: knownBytes - imageBytes
          }
        ]
      },
      files: entries('file', sizes),
      directories: entries('directory', directoryBytes)
    })
  )
}

test('handles empty, unknown-only, and zero-only scans without fabricating byte observations', () => {
  expect(observations([])).toEqual({ scanId: 'saved', incomplete: false, observations: [] })
  expect(observations([0, 0])).toEqual({ scanId: 'saved', incomplete: false, observations: [] })
  expect(observations([], { errorCount: 2 })).toMatchObject({
    incomplete: true,
    observations: [
      {
        type: 'incompleteScan',
        severity: 'warning',
        evidence: { errorCount: 2, unknownSizeCount: 0 }
      }
    ]
  })
  expect(observations([null, null])).toMatchObject({
    incomplete: true,
    observations: [{ type: 'incompleteScan', evidence: { errorCount: 0, unknownSizeCount: 2 } }]
  })
  expect(observations(Array(20).fill(0)).observations).toMatchObject([
    { type: 'smallFilesPrevalence', evidence: { smallFileCount: 20, knownSizeCount: 20 } }
  ])
})

test('small and zero-only scans can skip all concentration queries', () => {
  const read = vi.fn()
  buildObservations(
    {
      scanId: 'saved',
      summary: { fileCount: 20, directoryCount: 1, errorCount: 0, totalBytes: 0 }
    },
    {
      scanId: 'saved',
      incomplete: false,
      knownSizeCount: 20,
      totals: { fileCount: 20, knownBytes: 0, unknownSizeCount: 0 },
      buckets: INSIGHTS_SIZE_BUCKETS.map(({ id }) => ({
        id,
        fileCount: id === 'empty' ? 20 : 0,
        knownBytes: 0
      }))
    },
    read
  )
  expect(read).not.toHaveBeenCalled()
})

test('applies inclusive byte thresholds, minimum samples and independent non-root directory shares', () => {
  const exact = observations(Array(10).fill(10), { imageBytes: 60, directoryBytes: [50, 45] })
  expect(exact.observations).toMatchObject([
    {
      type: 'largeFileConcentration',
      evidence: { fileCount: 5, knownBytes: 50, totalKnownBytes: 100 }
    },
    {
      type: 'dominantCategory',
      evidence: { category: 'images', knownBytes: 60, totalKnownBytes: 100 }
    },
    {
      type: 'directoryConcentration',
      evidence: { entryId: 'directory-0', knownBytes: 50, totalKnownBytes: 100 }
    }
  ])
  expect(
    observations(Array(11).fill(10), { imageBytes: 65, directoryBytes: [54, 53] }).observations
  ).toEqual([])
  expect(
    observations(Array(9).fill(10), { imageBytes: 90, directoryBytes: [90, 10] }).observations
  ).toEqual([])
  expect(
    observations(Array(10).fill(10), { imageBytes: 50, directoryBytes: [100] }).observations.map(
      ({ type }) => type
    )
  ).toEqual(['largeFileConcentration'])
})

test('uses the known count for the small-file share and requires at least twenty samples', () => {
  const large = 1_048_576
  const exact = observations([
    ...Array(8).fill(0),
    ...Array(8).fill(large - 1),
    ...Array(4).fill(large),
    null,
    null
  ])
  expect(exact.observations.find(({ type }) => type === 'smallFilesPrevalence')?.evidence).toEqual({
    smallFileCount: 16,
    knownSizeCount: 20
  })
  const below = observations([...Array(15).fill(0), ...Array(5).fill(large)])
  expect(below.observations.some(({ type }) => type === 'smallFilesPrevalence')).toBe(false)
  expect(observations(Array(19).fill(0)).observations).toEqual([])
})

test('uses exact integer cross-products at the upper safe byte range', () => {
  const total = 9_000_000_000_000_001
  const sizes = Array.from({ length: 10 }, (_, i) =>
    i === 0 ? 900_000_000_000_001 : 900_000_000_000_000
  )
  const near = observations(sizes, {
    imageBytes: 5_400_000_000_000_000,
    directoryBytes: [4_500_000_000_000_000, 1]
  })
  expect(near.observations).toMatchObject([
    {
      type: 'largeFileConcentration',
      evidence: { totalKnownBytes: total, knownBytes: 4_500_000_000_000_001 }
    }
  ])
})

test('returns the five stable IDs in priority order with factual text and bounded evidence', () => {
  const sizes = [3_000_000, 2_800_000, 2_700_000, 2_600_000, ...Array(16).fill(100), null]
  const input = { errorCount: 1, imageBytes: 9_000_000, directoryBytes: [8_000_000, 7_000_000] }
  const result = observations(sizes, input)
  expect(result.observations.map(({ id, type }) => [id, type])).toEqual(
    INSIGHTS_OBSERVATION_TYPES.map((type) => [type, type])
  )
  expect(result).toEqual(observations(sizes, input))
  expect(result.observations.map(({ severity }) => severity)).toEqual([
    'warning',
    'info',
    'info',
    'info',
    'info'
  ])
  expect(
    result.observations.every(({ title, message }) => title.length > 0 && message.length > 0)
  ).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(
    /remove|delet|clean.?up|physical|disk allocation|\/fixture\//i
  )
})
