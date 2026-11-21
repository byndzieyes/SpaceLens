import type { InsightsSummary } from '../../shared/insights'
import type { ScanStorageCoordinator } from '../storage/coordinator'
import { readSnapshotId } from '../storage/snapshotAccess'

export class InsightsQueryService {
  constructor(private readonly storage: Pick<ScanStorageCoordinator, 'read'>) {}

  async getSummary(request: unknown, signal: AbortSignal): Promise<InsightsSummary> {
    const scanId = readSnapshotId(request)
    const scan = await this.storage.read(signal, (client) => client.requirePublishedScan(scanId))
    if (scan.id !== scanId) throw new Error('Storage returned a different publication.')
    return {
      scanId: scan.id,
      rootPath: scan.rootPath,
      completedAt: scan.finishedAt,
      summary: scan.summary,
      incomplete: scan.summary.errorCount > 0
    }
  }
}
