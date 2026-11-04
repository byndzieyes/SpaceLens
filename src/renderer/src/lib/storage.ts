const gigabytes = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

function validateBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('Storage sizes must be finite, nonnegative byte counts.')
  }
}

/** Decimal GB: 1 GB = 1,000,000,000 bytes. */
export function formatStorageSize(bytes: number): string {
  validateBytes(bytes)
  return `${gigabytes.format(bytes / 1_000_000_000)} GB`
}

export function getStorageUsage(
  totalBytes: number,
  usedBytes: number
): { availableBytes: number; usedPercentage: number } {
  validateBytes(totalBytes)
  validateBytes(usedBytes)
  if (usedBytes > totalBytes) {
    throw new RangeError('Used space cannot exceed total capacity.')
  }

  return {
    availableBytes: totalBytes - usedBytes,
    usedPercentage: totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 1000) / 10
  }
}
