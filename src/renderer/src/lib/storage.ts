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

const sizes = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Decimal units, retaining small file sizes instead of rounding everything to GB. */
export function formatBytes(bytes: number | bigint): string {
  if (typeof bytes === 'bigint') {
    const unit = Math.min(Math.floor((bytes.toString().length - 1) / 3), units.length - 1)
    const factor = 1000n ** BigInt(unit)
    const rounded = (bytes * 100n + factor / 2n) / factor
    // A Windows UInt64 count scaled to its display unit always fits safely in Number.
    return `${sizes.format(Number(rounded) / 100)} ${units[unit]}`
  }
  const unit = bytes === 0 ? 0 : Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  return `${sizes.format(bytes / 1000 ** unit)} ${units[unit]}`
}
