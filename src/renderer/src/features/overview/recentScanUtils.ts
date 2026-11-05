import type { RecentScanSummary } from '../../../../shared/scan'

const completionDateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

export function getRecentScans(scans: readonly RecentScanSummary[]): RecentScanSummary[] {
  return [...scans]
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, 5)
}

/** Display completion times in the user's local timezone using a 24-hour clock. */
export function formatScanDate(completedAt: string): string {
  return completionDateFormat.format(new Date(completedAt))
}
