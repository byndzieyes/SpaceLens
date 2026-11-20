// @vitest-environment node
import { expect, test } from 'vitest'
import { validateSnapshotRequest } from '../src/main/storage/snapshotAccess'
import type { ScanDirectoryRequest } from '../src/shared/snapshot'

const request = (): ScanDirectoryRequest => ({
  scanId: 'scan',
  entryId: 'root',
  offset: 0,
  limit: 100
})

test.each([
  null,
  [],
  {},
  { ...request(), extra: true },
  { ...request(), scanId: '' },
  { ...request(), entryId: '../file' },
  { ...request(), scanId: 'a'.repeat(129) },
  ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((offset) => ({
    ...request(),
    offset
  })),
  ...[0, -1, 101, 1.1, NaN, '5'].map((limit) => ({ ...request(), limit }))
])('validates retrieval arguments: %o', (invalid) => {
  expect(() => validateSnapshotRequest(invalid as ScanDirectoryRequest, true)).toThrow(
    'Valid snapshot IDs'
  )
})

test('accepts bounded requests and rejects pagination on single-entry requests', () => {
  expect(() => validateSnapshotRequest(request(), true)).not.toThrow()
  expect(() => validateSnapshotRequest({ scanId: 'scan', entryId: 'root' }, false)).not.toThrow()
  expect(() => validateSnapshotRequest(request(), false)).toThrow('Valid snapshot IDs')
})
