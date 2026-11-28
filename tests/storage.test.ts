import { expect, test } from 'vitest'
import { readDriveCapacity } from '../src/main/storageDevices'
import { formatStorageSize } from '../src/renderer/src/lib/storage'

test('formats decimal gigabytes consistently, with at most one decimal place', () => {
  expect(formatStorageSize(0)).toBe('0 GB')
  expect(formatStorageSize(1_000_000_000)).toBe('1 GB')
  expect(formatStorageSize(1_250_000_000)).toBe('1.3 GB')
  expect(formatStorageSize(476_000_000_000)).toBe('476 GB')
})

test('preserves reported free space and derives used bytes and percentages', () => {
  expect(readDriveCapacity('476000000000', '94000000000')).toEqual({
    totalBytes: '476000000000',
    freeBytes: '94000000000',
    usedBytes: '382000000000',
    usedPercentage: 80.3
  })
  expect(readDriveCapacity('256000000000', '128000000000')).toEqual({
    totalBytes: '256000000000',
    freeBytes: '128000000000',
    usedBytes: '128000000000',
    usedPercentage: 50
  })
})

test('handles zero capacity, empty and full devices without invalid percentages', () => {
  expect(readDriveCapacity('0', '0')).toMatchObject({ freeBytes: '0', usedPercentage: 0 })
  expect(readDriveCapacity('1000', '1000')).toMatchObject({ freeBytes: '1000', usedPercentage: 0 })
  expect(readDriveCapacity('1000', '0')).toMatchObject({ freeBytes: '0', usedPercentage: 100 })
})

test('rejects invalid sizes and inconsistent capacity rather than displaying invalid usage', () => {
  for (const bytes of [-1, NaN, Infinity, -Infinity]) {
    expect(() => formatStorageSize(bytes)).toThrow(RangeError)
    expect(readDriveCapacity(String(bytes), '0')).toBeNull()
    expect(readDriveCapacity('1000', String(bytes))).toBeNull()
  }
  expect(readDriveCapacity('100', '101')).toBeNull()
  expect(readDriveCapacity('0', '1')).toBeNull()
})
