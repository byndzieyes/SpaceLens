import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCAN_HISTORY_LIMIT,
  DEFAULT_SCAN_HISTORY_PAGE_SIZE,
  isScanHistoryRetentionSettings,
  MAX_SCAN_HISTORY_PAGE_SIZE,
  resolveScanHistoryQuery
} from '../src/shared/history'

describe('scan history pagination', () => {
  it('defaults each omitted field independently', () => {
    expect(resolveScanHistoryQuery({})).toEqual({
      offset: 0,
      limit: DEFAULT_SCAN_HISTORY_PAGE_SIZE,
      sort: 'newest'
    })
    expect(resolveScanHistoryQuery({ offset: 3 })).toEqual({
      offset: 3,
      limit: DEFAULT_SCAN_HISTORY_PAGE_SIZE,
      sort: 'newest'
    })
    expect(resolveScanHistoryQuery({ limit: 1 })).toEqual({ offset: 0, limit: 1, sort: 'newest' })
  })

  it('accepts the largest allowed page and a safe offset beyond the available history', () => {
    const query = { offset: Number.MAX_SAFE_INTEGER, limit: MAX_SCAN_HISTORY_PAGE_SIZE }
    expect(resolveScanHistoryQuery(query)).toEqual({ ...query, sort: 'newest' })
  })

  it('preserves root filters literally and normalizes pagination and sorting', () => {
    const filters = { rootPath: "C:\\Data\\📁 '%_'", rootPathContains: "%_'", sort: 'size-desc' }
    expect(resolveScanHistoryQuery(filters)).toEqual({ ...filters, offset: 0, limit: 20 })
  })

  it.each(
    [
      null,
      [],
      new Date(0),
      new Map(),
      'history',
      { path: 'C:\\' },
      { rootPath: '' },
      { rootPath: 'x'.repeat(32768) },
      { rootPathContains: 'a\0b' },
      { rootPathContains: undefined },
      { sort: 'total_bytes DESC' },
      { offset: -1 },
      { offset: 1.5 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { offset: '1' },
      { offset: undefined },
      { limit: 0 },
      { limit: MAX_SCAN_HISTORY_PAGE_SIZE + 1 },
      { limit: Infinity }
    ].map((request) => ({ request }))
  )('rejects invalid pagination $request', ({ request }) => {
    expect(resolveScanHistoryQuery(request)).toBeNull()
  })
})

describe('scan history retention settings', () => {
  it('accepts the default of ten snapshots and positive safe integer limits', () => {
    expect(DEFAULT_SCAN_HISTORY_LIMIT).toBe(10)
    for (const maxCompletedSnapshots of [1, DEFAULT_SCAN_HISTORY_LIMIT, Number.MAX_SAFE_INTEGER]) {
      expect(isScanHistoryRetentionSettings({ maxCompletedSnapshots })).toBe(true)
    }
  })

  it.each(
    [
      null,
      [],
      {},
      { maxCompletedSnapshots: 0 },
      { maxCompletedSnapshots: -1 },
      { maxCompletedSnapshots: 2.5 },
      { maxCompletedSnapshots: Number.MAX_SAFE_INTEGER + 1 },
      { maxCompletedSnapshots: '10' },
      { maxCompletedSnapshots: 10, rootPath: 'C:\\' }
    ].map((settings) => ({ settings }))
  )('rejects invalid settings $settings', ({ settings }) => {
    expect(isScanHistoryRetentionSettings(settings)).toBe(false)
  })
})
