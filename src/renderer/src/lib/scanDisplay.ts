const completionDateOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
} satisfies Intl.DateTimeFormatOptions
const completionDateFormat = new Intl.DateTimeFormat('en-US', completionDateOptions)
const preciseDateFormat = new Intl.DateTimeFormat('en-US', {
  ...completionDateOptions,
  second: '2-digit',
  fractionalSecondDigits: 3
})
const durationUnits = new Intl.NumberFormat('en-US')

/** Display completion times in the user's local timezone using a 24-hour clock. */
export function formatScanDate(completedAt: string): string {
  return completionDateFormat.format(new Date(completedAt))
}

export function formatPreciseScanDate(completedAt: string): string {
  return preciseDateFormat.format(new Date(completedAt))
}

/** Compact elapsed time for completed scans. */
export function formatScanDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationUnits.format(durationMs)} ms`
  const seconds = Math.floor(durationMs / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return [
    hours ? `${durationUnits.format(hours)} h` : '',
    minutes ? `${minutes} m` : '',
    `${seconds % 60} s`
  ]
    .filter(Boolean)
    .join(' ')
}
