import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatStorageSize, getStorageUsage } from '../src/renderer/src/lib/storage.ts'

test('formats decimal gigabytes consistently, with at most one decimal place', () => {
  assert.equal(formatStorageSize(0), '0 GB')
  assert.equal(formatStorageSize(1_000_000_000), '1 GB')
  assert.equal(formatStorageSize(1_250_000_000), '1.3 GB')
  assert.equal(formatStorageSize(476_000_000_000), '476 GB')
})

test('derives available space and percentage for both demo drives', () => {
  assert.deepEqual(getStorageUsage(476_000_000_000, 382_000_000_000), {
    availableBytes: 94_000_000_000,
    usedPercentage: 80.3
  })
  assert.deepEqual(getStorageUsage(256_000_000_000, 128_000_000_000), {
    availableBytes: 128_000_000_000,
    usedPercentage: 50
  })
})

test('handles zero capacity, empty and full devices without invalid percentages', () => {
  assert.deepEqual(getStorageUsage(0, 0), { availableBytes: 0, usedPercentage: 0 })
  assert.deepEqual(getStorageUsage(1_000, 0), { availableBytes: 1_000, usedPercentage: 0 })
  assert.deepEqual(getStorageUsage(1_000, 1_000), { availableBytes: 0, usedPercentage: 100 })
})

test('rejects invalid sizes and inconsistent capacity rather than displaying invalid usage', () => {
  for (const bytes of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => formatStorageSize(bytes), RangeError)
    assert.throws(() => getStorageUsage(bytes, 0), RangeError)
    assert.throws(() => getStorageUsage(1_000, bytes), RangeError)
  }
  assert.throws(() => getStorageUsage(100, 101), RangeError)
  assert.throws(() => getStorageUsage(0, 1), RangeError)
})
