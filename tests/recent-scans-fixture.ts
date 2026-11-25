import type { ScanHistoryItem, ScanHistoryPage } from '../src/shared/history'
import type { RecentScanSummary } from '../src/shared/scan'

export function recentScanItem(scan: RecentScanSummary): ScanHistoryItem {
  return {
    id: scan.id,
    rootPath: scan.path,
    status: 'completed',
    startedAt: new Date(Date.parse(scan.completedAt) - 65_000).toISOString(),
    finishedAt: scan.completedAt,
    durationMs: 65_000,
    summary: {
      totalBytes: scan.totalBytes,
      fileCount: scan.fileCount,
      directoryCount: scan.directoryCount ?? 1,
      errorCount: scan.errorCount ?? 0
    },
    isLatest: false,
    incomplete: (scan.errorCount ?? 0) > 0
  }
}

export function recentHistoryPage(items: readonly ScanHistoryItem[] = []): ScanHistoryPage {
  const latestCompletedScanId = items[0]?.id ?? null
  return {
    items: items
      .slice(0, 5)
      .map((item) => ({ ...item, isLatest: item.id === latestCompletedScanId })),
    offset: 0,
    limit: 5,
    totalCount: items.length,
    nextOffset: items.length > 5 ? 5 : null,
    latestCompletedScanId
  }
}
