// @vitest-environment node

import { expect, test } from 'vitest'
import { ScanDatabase } from '../src/main/storage/database'
import type { RetentionCandidate } from '../src/main/storage/payloads'
import { parseStorageRequest } from '../src/main/storage/workerProtocol'
import { buildingFixture, legacyScan } from './v1-scan-fixture'
import { join } from 'node:path'

function save(db: ScanDatabase, index: number, finishedAt = legacyScan.finishedAt): void {
  db.insertScan({
    ...legacyScan,
    id: `scan-${index}`,
    rootPath: join(legacyScan.rootPath, index % 2 === 0 ? 'even' : 'odd'),
    finishedAt
  })
}

test('discovers one global oldest candidate by sequence and skips protected snapshots', () => {
  const db = new ScanDatabase(':memory:')
  try {
    const discover = (limit: number, protectedScanIds: string[] = []): RetentionCandidate =>
      db.getRetentionCandidate({ limit, protectedScanIds })
    expect(discover(1)).toEqual({
      totalCount: 0,
      latestScanId: null,
      candidateScanId: null,
      building: false
    })
    save(db, 0)
    save(db, 1)
    save(db, 2, '2026-11-20T13:02:00Z')
    expect(discover(4).candidateScanId).toBeNull()
    expect(discover(3).candidateScanId).toBeNull()
    expect(discover(2)).toEqual({
      totalCount: 3,
      latestScanId: 'scan-2',
      candidateScanId: 'scan-0',
      building: false
    })
    expect(discover(1, ['scan-0']).candidateScanId).toBe('scan-1')
    expect(discover(1, ['scan-0', 'scan-1']).candidateScanId).toBeNull()
    db.beginScan(buildingFixture('building'))
    expect(discover(1)).toMatchObject({
      totalCount: 3,
      building: true,
      latestScanId: 'scan-2',
      candidateScanId: null
    })
  } finally {
    db.close()
  }
})

test('bounds candidate output even with far more rows than the limit', () => {
  const db = new ScanDatabase(':memory:')
  try {
    db.transaction(() => {
      for (let index = 0; index < 300; index++) save(db, index)
    })
    expect(db.getRetentionCandidate({ limit: 1, protectedScanIds: ['scan-0', 'scan-1'] })).toEqual({
      totalCount: 300,
      latestScanId: 'scan-299',
      candidateScanId: 'scan-2',
      building: false
    })
    for (const protectedScanIds of [Array(65).fill('saved'), ['bad/path']]) {
      expect(() =>
        parseStorageRequest({
          requestId: 1,
          operation: 'getRetentionCandidate',
          payload: { limit: 1, protectedScanIds }
        })
      ).toThrow('Invalid payload')
    }
  } finally {
    db.close()
  }
})

test('a stale candidate is skipped when it becomes Latest, falls within the limit or loses oldest eligibility', () => {
  const db = new ScanDatabase(':memory:')
  try {
    save(db, 0)
    save(db, 1)
    save(db, 2)
    const attempt = { scanId: 'scan-1', limit: 1, protectedScanIds: ['scan-0'] }
    expect(db.getRetentionCandidate(attempt).candidateScanId).toBe(attempt.scanId)
    expect(db.pruneSnapshot({ ...attempt, protectedScanIds: [] })).toBeNull()
    expect(db.pruneSnapshot({ ...attempt, limit: 3 })).toBeNull()
    db.deleteSnapshot({ scanId: 'scan-2' })
    expect(db.pruneSnapshot(attempt)).toBeNull()
    expect(db.getPublishedScan()?.id).toBe('scan-1')
    expect(db.pruneSnapshot({ ...attempt, scanId: 'scan-0', protectedScanIds: [] })).toMatchObject({
      scanId: 'scan-0',
      latestCompletedScanId: 'scan-1'
    })
  } finally {
    db.close()
  }
})
