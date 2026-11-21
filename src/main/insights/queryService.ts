import type {
  InsightsCategories,
  InsightsExtensionPage,
  InsightsSummary
} from '../../shared/insights'
import type { ScanStorageCoordinator } from '../storage/coordinator'
import { readExtensionRequest, readSnapshotId } from '../storage/snapshotAccess'

function assertPublication(actual: string, requested: string): void {
  if (actual !== requested) throw new Error('Storage returned a different publication.')
}

export class InsightsQueryService {
  constructor(private readonly storage: Pick<ScanStorageCoordinator, 'read'>) {}

  async getSummary(request: unknown, signal: AbortSignal): Promise<InsightsSummary> {
    const scanId = readSnapshotId(request)
    const scan = await this.storage.read(signal, (client) => client.requirePublishedScan(scanId))
    assertPublication(scan.id, scanId)
    return {
      scanId: scan.id,
      rootPath: scan.rootPath,
      completedAt: scan.finishedAt,
      summary: scan.summary,
      incomplete: scan.summary.errorCount > 0
    }
  }

  async getCategories(request: unknown, signal: AbortSignal): Promise<InsightsCategories> {
    const scanId = readSnapshotId(request)
    const result = await this.storage.read(signal, (client) => client.getInsightsCategories(scanId))
    assertPublication(result.scanId, scanId)
    return result
  }

  async listExtensions(request: unknown, signal: AbortSignal): Promise<InsightsExtensionPage> {
    const page = readExtensionRequest(request)
    const result = await this.storage.read(signal, (client) => client.listInsightsExtensions(page))
    assertPublication(result.scanId, page.scanId)
    return result
  }
}
