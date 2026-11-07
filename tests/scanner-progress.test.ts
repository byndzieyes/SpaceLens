// @vitest-environment node
import { expect, test } from 'vitest'
import type { FileEntry } from '../src/shared/scan'
import { ScanProgressTracker } from '../src/main/scanner/progress'
import type { ScanSummaryEvent } from '../src/main/scanner/summary'

const scanId = 'progress-test'
function entry(type: FileEntry['type'], sizeBytes: number | null = null): FileEntry {
  return {
    id: type,
    scanId,
    parentId: type === 'directory' ? null : 'directory',
    path: `/root/${type}`,
    name: type,
    type,
    sizeBytes,
    aggregatedSizeBytes: null,
    createdAt: null,
    modifiedAt: null
  }
}

test('starts with zero observations and no current path', () => {
  expect(new ScanProgressTracker(scanId).snapshot()).toEqual({
    scanId,
    processedFileCount: 0,
    processedDirectoryCount: 0,
    processedBytes: 0,
    currentPath: null
  })
})

test('counts only discoveries and preserves independent cumulative snapshots', () => {
  const tracker = new ScanProgressTracker(scanId)
  const root = entry('directory')
  tracker.accept({ type: 'entry', entry: root })
  const first = tracker.snapshot()
  tracker.accept({ type: 'entry', entry: entry('file', 50) })
  tracker.accept({ type: 'entry', entry: { ...root, id: 'nested', parentId: root.id } })
  tracker.accept({ type: 'entry', entry: { ...entry('file', 100), id: 'nested-file' } })
  tracker.accept({ type: 'directory-finalized', entry: { ...root, aggregatedSizeBytes: 150 } })
  expect(first.processedFileCount).toBe(0)
  expect(first.processedDirectoryCount).toBe(1)
  expect(tracker.snapshot()).toEqual({
    scanId,
    processedFileCount: 2,
    processedDirectoryCount: 2,
    processedBytes: 150,
    currentPath: root.path
  })
})

test('ignores link targets, nonregular entries and unknown sizes without losing the current path', () => {
  const tracker = new ScanProgressTracker(scanId)
  for (const type of ['symlink', 'other', 'unknown', 'file'] as const) {
    tracker.accept({ type: 'entry', entry: entry(type) })
    expect(tracker.snapshot().currentPath).toBe(`/root/${type}`)
  }
  tracker.accept({ type: 'entry', entry: { ...entry('file', 0), id: 'zero' } })
  tracker.accept({
    type: 'error',
    error: { path: '/root/private', code: 'EACCES', message: 'Denied' }
  })
  expect(tracker.snapshot()).toEqual({
    scanId,
    processedFileCount: 2,
    processedDirectoryCount: 0,
    processedBytes: 0,
    currentPath: '/root/private'
  })
})

test('accepts the safe-integer boundary and rejects overflow without changing counters', () => {
  const tracker = new ScanProgressTracker(scanId)
  tracker.accept({ type: 'entry', entry: entry('file', Number.MAX_SAFE_INTEGER) })
  const previous = tracker.snapshot()
  expect(() => tracker.accept({ type: 'entry', entry: entry('file', 1) })).toThrow(RangeError)
  expect(tracker.snapshot()).toEqual(previous)
})

test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid logical bytes: %s',
  (bytes) => {
    const tracker = new ScanProgressTracker(scanId)
    expect(() => tracker.accept({ type: 'entry', entry: entry('file', bytes) })).toThrow(RangeError)
    expect(tracker.snapshot().processedFileCount).toBe(0)
  }
)

test('validates scan identity and final summary consistency without resetting the path', () => {
  const tracker = new ScanProgressTracker(scanId)
  const root = entry('directory')
  tracker.accept({ type: 'entry', entry: root })
  const summary: ScanSummaryEvent = {
    type: 'summary',
    scanId,
    rootEntryId: root.id,
    summary: { fileCount: 0, directoryCount: 1, totalBytes: 0, errorCount: 0 }
  }
  tracker.accept(summary)
  expect(tracker.snapshot().currentPath).toBe(root.path)
  for (const field of ['fileCount', 'directoryCount', 'totalBytes'] as const) {
    expect(() =>
      tracker.accept({ ...summary, summary: { ...summary.summary, [field]: 42 } })
    ).toThrow('differs')
  }
  expect(() => tracker.accept({ ...summary, scanId: 'wrong' })).toThrow('different scan')
  expect(() => tracker.accept({ type: 'entry', entry: { ...root, scanId: 'wrong' } })).toThrow(
    'different scan'
  )
})
