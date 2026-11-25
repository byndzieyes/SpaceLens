import type {
  InsightsCategories,
  InsightsExtensionPage,
  InsightsObservations,
  InsightsRankedEntry,
  InsightsRankingPage,
  InsightsSummary,
  InsightsSizeDistribution
} from '../../shared/insights'
import type { ScanStorageCoordinator } from '../storage/coordinator'
import { readExtensionRequest, readRankingRequest, readSnapshotId } from '../storage/snapshotAccess'

function assertPublication(actual: string, requested: string): void {
  if (actual !== requested) throw new Error('Storage returned a different publication.')
}

export class InsightsQueryService {
  constructor(private readonly storage: Pick<ScanStorageCoordinator, 'read'>) {}

  async getSummary(request: unknown, signal: AbortSignal): Promise<InsightsSummary> {
    const scanId = readSnapshotId(request)
    const scan = await this.storage.read(
      signal,
      (client) => client.requireValidatedScan(scanId),
      scanId
    )
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
    const result = await this.storage.read(
      signal,
      (client) => client.getInsightsCategories(scanId),
      scanId
    )
    assertPublication(result.scanId, scanId)
    return result
  }

  async getSizeDistribution(
    request: unknown,
    signal: AbortSignal
  ): Promise<InsightsSizeDistribution> {
    const scanId = readSnapshotId(request)
    const result = await this.storage.read(
      signal,
      (client) => client.getInsightsSizeDistribution(scanId),
      scanId
    )
    assertPublication(result.scanId, scanId)
    return result
  }

  async getObservations(request: unknown, signal: AbortSignal): Promise<InsightsObservations> {
    const scanId = readSnapshotId(request)
    const result = await this.storage.read(
      signal,
      (client) => client.getInsightsObservations(scanId),
      scanId
    )
    assertPublication(result.scanId, scanId)
    return result
  }

  async listExtensions(request: unknown, signal: AbortSignal): Promise<InsightsExtensionPage> {
    const page = readExtensionRequest(request)
    const result = await this.storage.read(
      signal,
      (client) => client.listInsightsExtensions(page),
      page.scanId
    )
    assertPublication(result.scanId, page.scanId)
    return result
  }

  async listLargest(
    request: unknown,
    type: InsightsRankedEntry['type'],
    signal: AbortSignal
  ): Promise<InsightsRankingPage> {
    const page = readRankingRequest(request)
    const result = await this.storage.read(
      signal,
      (client) =>
        type === 'file'
          ? client.listInsightsLargestFiles(page)
          : client.listInsightsLargestDirectories(page),
      page.scanId
    )
    assertPublication(result.scanId, page.scanId)
    if (result.offset !== page.offset || result.limit !== page.limit) {
      throw new Error('Storage returned a different ranking page.')
    }
    return result
  }
}
