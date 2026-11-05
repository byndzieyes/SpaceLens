import type { RecentScanSummary } from '../../../../shared/scan'

// Example history for the explicit demo toggle; no filesystem data is read.
export const demoScans: readonly RecentScanSummary[] = [
  {
    id: 'demo-projects',
    path: 'C:\\Projects',
    completedAt: '2026-11-05T12:30:00Z',
    totalBytes: 24_600_000_000,
    fileCount: 48_210
  },
  {
    id: 'demo-media',
    path: 'D:\\Media',
    completedAt: '2026-11-04T16:15:00Z',
    totalBytes: 112_400_000_000,
    fileCount: 3_842
  },
  {
    id: 'demo-documents',
    path: 'C:\\Users\\Demo\\Documents',
    completedAt: '2026-11-03T09:45:00Z',
    totalBytes: 5_200_000_000,
    fileCount: 1_276
  }
]
