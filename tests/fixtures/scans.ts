import type { RecentScanSummary } from '../../src/shared/scan'

export function createScanSummary(
  id: string,
  completedAt: string,
  overrides: Partial<RecentScanSummary> = {}
): RecentScanSummary {
  return {
    id,
    path: `C:\\Test fixtures\\${id}`,
    completedAt,
    totalBytes: 12_500_000_000,
    fileCount: 12_345,
    ...overrides
  }
}

export const demoScanFixtures: readonly RecentScanSummary[] = [
  createScanSummary('demo-projects', '2026-11-05T14:30:00Z'),
  createScanSummary('demo-media', '2026-11-04T10:00:00Z')
]
