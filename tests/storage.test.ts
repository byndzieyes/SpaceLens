import { expect, test } from 'vitest'
import { formatStorageSize, getStorageUsage } from '../src/renderer/src/lib/storage'

test('formats decimal gigabytes consistently, with at most one decimal place', () => {
  expect(formatStorageSize(0)).toBe('0 GB')
  expect(formatStorageSize(1_000_000_000)).toBe('1 GB')
  expect(formatStorageSize(1_250_000_000)).toBe('1.3 GB')
  expect(formatStorageSize(476_000_000_000)).toBe('476 GB')
})

test('derives available space and percentage for both demo drives', () => {
  expect(getStorageUsage(476_000_000_000, 382_000_000_000)).toEqual({
    availableBytes: 94_000_000_000,
    usedPercentage: 80.3
  })
  expect(getStorageUsage(256_000_000_000, 128_000_000_000)).toEqual({
    availableBytes: 128_000_000_000,
    usedPercentage: 50
  })
})

test('handles zero capacity, empty and full devices without invalid percentages', () => {
  expect(getStorageUsage(0, 0)).toEqual({ availableBytes: 0, usedPercentage: 0 })
  expect(getStorageUsage(1_000, 0)).toEqual({ availableBytes: 1_000, usedPercentage: 0 })
  expect(getStorageUsage(1_000, 1_000)).toEqual({ availableBytes: 0, usedPercentage: 100 })
})

test('rejects invalid sizes and inconsistent capacity rather than displaying invalid usage', () => {
  for (const bytes of [-1, NaN, Infinity, -Infinity]) {
    expect(() => formatStorageSize(bytes)).toThrow(RangeError)
    expect(() => getStorageUsage(bytes, 0)).toThrow(RangeError)
    expect(() => getStorageUsage(1_000, bytes)).toThrow(RangeError)
  }
  expect(() => getStorageUsage(100, 101)).toThrow(RangeError)
  expect(() => getStorageUsage(0, 1)).toThrow(RangeError)
})
