// @vitest-environment node

import { expect, test } from 'vitest'
import {
  comparisonMetadataForStoredScan,
  evaluateComparisonCompatibility
} from '../src/main/comparison/compatibility'
import type { ComparisonSnapshotMetadata } from '../src/shared/comparison'

const pair = { baselineScanId: 'baseline', targetScanId: 'target' }

function saved(
  id: string,
  rootPath = '/project',
  errorCount = 0,
  status: ComparisonSnapshotMetadata['status'] = 'completed'
): ComparisonSnapshotMetadata {
  return comparisonMetadataForStoredScan({ id, rootPath, status, summary: { errorCount } })
}

test.each([
  ['/project/', '/project', '/project', 'posix'],
  ['/', '/', '/', 'posix'],
  ['C:\\', 'c:/', 'c:/', 'win32'],
  ['C:\\Project\\', 'c:/Project', 'c:/Project', 'win32'],
  ['\\\\Server\\Share', '\\\\Server\\Share\\', '//Server/Share/', 'win32'],
  ['\\\\Server\\Share\\Dir\\', '\\\\Server\\Share/Dir', '//Server/Share/Dir', 'win32']
] as const)('accepts equivalent completed roots %s and %s', (from, to, root, pathStyle) => {
  expect(
    evaluateComparisonCompatibility(pair, saved('baseline', from), saved('target', to))
  ).toEqual({
    pair,
    status: 'compatible',
    normalizedRoot: root,
    pathStyle,
    coverage: { baseline: 'complete', target: 'complete' }
  })
})

test.each([
  ['/project', '/elsewhere'],
  ['/project', '/project/nested'],
  ['/project', '/Project'],
  ['/a\\b', '/a/b'],
  ['C:\\Project', 'c:\\project'],
  ['C:\\Project', 'D:\\Project'],
  ['\\\\Server\\Share\\Dir', '\\\\Server\\Share\\Dir\\Nested'],
  ['\\\\Server\\Share', '\\\\Server\\Share2'],
  ['\\\\Server\\Share', '\\\\server\\Share']
])('requires the same exact root components for %s and %s', (from, to) => {
  expect(
    evaluateComparisonCompatibility(pair, saved('baseline', from), saved('target', to))
  ).toEqual({ pair, status: 'incompatible', reason: { code: 'DIFFERENT_ROOTS' } })
})

test('keeps reverse pairs directional and reports partial coverage on the correct side', () => {
  const baseline = { ...saved('baseline', '/project', 2), isLatest: true }
  const target = { ...saved('target'), isLatest: false }
  const reverse = { baselineScanId: 'target', targetScanId: 'baseline' }
  expect(evaluateComparisonCompatibility(pair, baseline, target)).toMatchObject({
    pair,
    status: 'compatible-with-warnings',
    coverage: { baseline: 'incomplete', target: 'complete' },
    warnings: [{ code: 'INCOMPLETE_COVERAGE', side: 'baseline' }]
  })
  expect(evaluateComparisonCompatibility(reverse, target, baseline)).toMatchObject({
    pair: reverse,
    status: 'compatible-with-warnings',
    coverage: { baseline: 'complete', target: 'incomplete' },
    warnings: [{ code: 'INCOMPLETE_COVERAGE', side: 'target' }]
  })
  expect(evaluateComparisonCompatibility(reverse, baseline, target)).toMatchObject({
    status: 'incompatible',
    reason: { code: 'SNAPSHOT_EXPIRED', side: 'baseline' }
  })
})

test('rejects a pair with the same ID even if the snapshot is currently unavailable', () => {
  expect(
    evaluateComparisonCompatibility({ baselineScanId: 'x', targetScanId: 'x' }, null, null)
  ).toMatchObject({ status: 'incompatible', reason: { code: 'SAME_SNAPSHOT' } })
})

test.each(['baseline', 'target'] as const)(
  'reports a missing %s through snapshot errors',
  (side) => {
    expect(
      evaluateComparisonCompatibility(
        pair,
        side === 'baseline' ? null : saved('baseline'),
        side === 'target' ? null : saved('target')
      )
    ).toMatchObject({ status: 'incompatible', reason: { code: 'SNAPSHOT_EXPIRED', side } })
  }
)

test.each(['running', 'failed', 'cancelled'] as const)('rejects a %s snapshot', (status) => {
  expect(
    evaluateComparisonCompatibility(pair, saved('baseline'), saved('target', '/project', 0, status))
  ).toMatchObject({
    status: 'incompatible',
    reason: { code: 'SNAPSHOT_UNAVAILABLE', side: 'target' }
  })
})

test('rejects known differences in platform or traversal policy', () => {
  const baseline = saved('baseline')
  const target = saved('target')
  for (const other of [
    saved('target', 'C:\\project'),
    { ...target, semantics: { pathStyle: 'posix', traversalPolicy: 'follow-links' } } as const
  ]) {
    expect(evaluateComparisonCompatibility(pair, baseline, other)).toMatchObject({
      status: 'incompatible',
      reason: { code: 'INCOMPATIBLE_SCAN_SEMANTICS' }
    })
  }
})

test('uses the same fixed policy for migrated and current snapshots without persisted options', () => {
  const migrated = saved('baseline', '/project', 3)
  const current = saved('target')
  expect(migrated.semantics).toEqual(current.semantics)
  expect(evaluateComparisonCompatibility(pair, migrated, current)).toMatchObject({
    status: 'compatible-with-warnings',
    warnings: [{ code: 'INCOMPLETE_COVERAGE', side: 'baseline' }]
  })
  expect(
    evaluateComparisonCompatibility(pair, { ...migrated, semantics: undefined }, current)
  ).toMatchObject({
    status: 'incompatible',
    reason: {
      code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
      field: 'scan-semantics',
      side: 'baseline'
    }
  })
})

test('does not accept two equal but unsupported traversal policies', () => {
  const semantics = { pathStyle: 'posix', traversalPolicy: 'unverified' } as const
  expect(
    evaluateComparisonCompatibility(
      pair,
      { ...saved('baseline'), semantics },
      { ...saved('target'), semantics }
    )
  ).toMatchObject({
    status: 'incompatible',
    reason: { code: 'INSUFFICIENT_COMPATIBILITY_METADATA', field: 'scan-semantics' }
  })
})

test('describes unknown coverage independently of established root and traversal compatibility', () => {
  expect(
    evaluateComparisonCompatibility(pair, { ...saved('baseline'), summary: {} }, saved('target'))
  ).toMatchObject({
    status: 'compatible-with-warnings',
    coverage: { baseline: 'unknown', target: 'complete' },
    warnings: [{ code: 'INSUFFICIENT_COMPATIBILITY_METADATA', field: 'coverage', side: 'baseline' }]
  })
})

test('fails safely on an ambiguous platform or unusable stored root', () => {
  expect(
    evaluateComparisonCompatibility(pair, saved('baseline', '//Server/Share'), saved('target'))
  ).toMatchObject({
    status: 'incompatible',
    reason: {
      code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
      field: 'scan-semantics',
      side: 'baseline'
    }
  })
  expect(
    evaluateComparisonCompatibility(pair, saved('baseline'), saved('target', '/some/../project'))
  ).toMatchObject({
    status: 'incompatible',
    reason: { code: 'INSUFFICIENT_COMPATIBILITY_METADATA', field: 'root-path', side: 'target' }
  })
})
