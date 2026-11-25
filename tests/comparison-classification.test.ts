// @vitest-environment node

import { expect, test } from 'vitest'
import {
  classifyFileChange,
  logicalByteDelta,
  observeComparisonPath
} from '../src/main/comparison/classification'
import type { ComparisonPathObservation } from '../src/shared/comparison'

type Entry = Extract<ComparisonPathObservation, { presence: 'present' }>['entry']
const path = 'nested/example.txt'
const time = '2026-01-01T00:00:00.000Z'
const later = '2026-01-01T00:00:00.001Z'
const absent = observeComparisonPath(null, 'complete')

function present(scanId: string, fields: Partial<Entry> = {}): ComparisonPathObservation {
  return observeComparisonPath(
    {
      entryId: 'entry-' + scanId,
      scanId,
      type: 'file',
      sizeBytes: 20,
      modifiedAt: time,
      ...fields
    },
    'incomplete'
  )
}

test('classifies confirmed additions and removals with directional bytes and entry references', () => {
  const target = present('target')
  const baseline = present('baseline')
  expect(classifyFileChange(path, absent, target)).toEqual({
    relativePath: path,
    baseline: { presence: 'absent' },
    target,
    kind: 'added',
    reason: 'confirmed-absence',
    deltaBytes: 20
  })
  expect(classifyFileChange(path, baseline, absent)).toEqual({
    relativePath: path,
    baseline,
    target: { presence: 'absent' },
    kind: 'removed',
    reason: 'confirmed-absence',
    deltaBytes: -20
  })
})

test.each([
  [{ sizeBytes: 25 }, 'size-changed', 5],
  [{ modifiedAt: later }, 'modified-time-changed', 0],
  [{ sizeBytes: 25, modifiedAt: later }, 'size-and-modified-time-changed', 5],
  [{ sizeBytes: 31, modifiedAt: null }, 'size-changed', 11],
  [{ sizeBytes: null, modifiedAt: later }, 'modified-time-changed', null]
] as const)(
  'uses any known metadata difference with target metadata %j',
  (fields, reason, deltaBytes) => {
    const from = present('baseline')
    const to = present('target', fields)
    expect(classifyFileChange(path, from, to)).toMatchObject({
      kind: 'modified',
      reason,
      deltaBytes
    })
    expect(classifyFileChange(path, to, from)).toMatchObject({
      kind: 'modified',
      reason,
      deltaBytes: deltaBytes ? -deltaBytes : deltaBytes
    })
  }
)

test('equal known logical size and millisecond mtime establish metadata equality', () => {
  expect(classifyFileChange(path, present('baseline'), present('target'))).toMatchObject({
    kind: 'unchanged',
    reason: 'metadata-equal',
    deltaBytes: 0
  })
})

test.each([
  [{ sizeBytes: null }, null],
  [{ modifiedAt: null }, 0],
  [{ modifiedAt: 'invalid' }, 0],
  [{ modifiedAt: '2026-02-31T00:00:00.000Z' }, 0],
  [{ sizeBytes: null, modifiedAt: null }, null]
] as const)('does not infer equality from unknown metadata %j', (fields, deltaBytes) => {
  for (const target of [present('target'), present('target', fields)]) {
    expect(classifyFileChange(path, present('baseline', fields), target)).toMatchObject({
      kind: 'indeterminate',
      reason: 'unknown-metadata',
      deltaBytes
    })
  }
})

test('distinguishes a zero-byte observation from an unknown size in every presence state', () => {
  const zero = present('target', { sizeBytes: 0 })
  const unknown = present('target', { sizeBytes: null })
  expect(classifyFileChange(path, absent, zero)).toMatchObject({ kind: 'added', deltaBytes: 0 })
  expect(classifyFileChange(path, zero, absent)).toMatchObject({ kind: 'removed', deltaBytes: 0 })
  expect(classifyFileChange(path, zero, zero)).toMatchObject({ kind: 'unchanged', deltaBytes: 0 })
  expect(classifyFileChange(path, absent, unknown)).toMatchObject({
    kind: 'added',
    deltaBytes: null
  })
  expect(classifyFileChange(path, unknown, absent)).toMatchObject({
    kind: 'removed',
    deltaBytes: null
  })
  expect(classifyFileChange(path, zero, unknown)).toMatchObject({
    kind: 'indeterminate',
    deltaBytes: null
  })
})

test.each(['incomplete', 'unknown'] as const)(
  'keeps a missing file under %s coverage indeterminate in either direction',
  (coverage) => {
    const missing = observeComparisonPath(null, coverage)
    expect(missing).toEqual({ presence: 'unknown' })
    for (const [from, to] of [
      [missing, present('target')],
      [present('baseline'), missing]
    ]) {
      expect(classifyFileChange(path, from, to)).toMatchObject({
        kind: 'indeterminate',
        reason: 'unknown-presence',
        deltaBytes: null
      })
    }
    expect(classifyFileChange(path, missing, absent)).toBeNull()
  }
)

test.each(['directory', 'symlink', 'other'] as const)(
  'treats a known %s replacement as a file-side event even on a partial scan',
  (type) => {
    const other = present('baseline', { type, sizeBytes: null })
    expect(classifyFileChange(path, other, present('target'))).toMatchObject({
      kind: 'added',
      reason: 'type-replacement',
      deltaBytes: 20
    })
    expect(classifyFileChange(path, present('target'), other)).toMatchObject({
      kind: 'removed',
      reason: 'type-replacement',
      deltaBytes: -20
    })
    expect(classifyFileChange(path, other, absent)).toBeNull()
  }
)

test('an observed entry of unknown type leaves regular-file presence unresolved', () => {
  const unknown = present('baseline', { type: 'unknown', sizeBytes: null })
  const known = present('target')
  expect(classifyFileChange(path, unknown, known)).toMatchObject({
    baseline: unknown,
    target: known,
    kind: 'indeterminate',
    reason: 'unknown-entry-type',
    deltaBytes: null
  })
  expect(classifyFileChange(path, known, unknown)).toMatchObject({
    kind: 'indeterminate',
    reason: 'unknown-entry-type'
  })
  expect(classifyFileChange(path, unknown, absent)).toBeNull()
  expect(classifyFileChange('', known, absent)).toBeNull()
})

test.each(['nested/renamed.txt', 'elsewhere/example.txt'])(
  'treats identical metadata at %s as independent path changes',
  (newPath) => {
    expect(classifyFileChange(path, present('baseline'), absent)).toMatchObject({
      relativePath: path,
      kind: 'removed'
    })
    expect(classifyFileChange(newPath, absent, present('target'))).toMatchObject({
      relativePath: newPath,
      kind: 'added'
    })
  }
)

test('produces exactly one exclusive count per file path and excludes non-files', () => {
  const baseline = present('baseline')
  const target = present('target')
  const missing = observeComparisonPath(null, 'incomplete')
  const results = [
    classifyFileChange('new', absent, target),
    classifyFileChange('old', baseline, absent),
    classifyFileChange('changed', baseline, present('target', { sizeBytes: 22 })),
    classifyFileChange('same', baseline, target),
    classifyFileChange('unknown', missing, target),
    classifyFileChange(
      'directory',
      absent,
      present('target', { type: 'directory', sizeBytes: null })
    )
  ]
  expect(results.map((result) => result?.kind ?? null)).toEqual([
    'added',
    'removed',
    'modified',
    'unchanged',
    'indeterminate',
    null
  ])
})

const max = Number.MAX_SAFE_INTEGER
test.each([
  [0, max, max],
  [max, 0, -max],
  [max - 1, max, 1],
  [max, max - 1, -1],
  [max, max, 0],
  [null, 0, null],
  [0, null, null],
  [null, null, null]
])('computes a safe Target-minus-Baseline delta for %s and %s', (baseline, target, delta) => {
  expect(logicalByteDelta(baseline, target)).toBe(delta)
})

test.each([max + 1, -1, 0.5, Number.POSITIVE_INFINITY, NaN])(
  'rejects unsafe logical byte input %s',
  (bytes) => {
    expect(() => logicalByteDelta(0, bytes)).toThrow(RangeError)
    expect(() => logicalByteDelta(bytes, null)).toThrow(RangeError)
  }
)
