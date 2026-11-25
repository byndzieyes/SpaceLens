import type { DatabaseSync } from 'node:sqlite'
import {
  INSIGHTS_RANKING_LIMIT,
  type InsightsCategories,
  type InsightsExtensionPage,
  type InsightsExtensionRequest,
  type InsightsObservations,
  type InsightsRankedEntry,
  type InsightsRankingPage,
  type InsightsRankingRequest,
  type InsightsSizeDistribution
} from '../../shared/insights'
import { buildObservations } from '../insights/observations'
import { AnalyticsCache } from './analyticsCache'
import { prepareFileSizeDistribution } from './fileSizeDistribution'
import { extensionPage, FileTypeAnalytics } from './fileTypeAnalytics'
import { LargestEntries } from './largestEntries'
import type { CompletedScan } from './payloads'

/** Analytics run synchronously on the Worker connection after saved-snapshot validation. */
export class PublishedAnalytics {
  private readonly cache = new AnalyticsCache()
  private readonly fileTypes: FileTypeAnalytics
  private readonly largestEntries: LargestEntries
  private readonly distribution: ReturnType<typeof prepareFileSizeDistribution>

  constructor(connection: DatabaseSync) {
    this.fileTypes = new FileTypeAnalytics(connection)
    this.largestEntries = new LargestEntries(connection)
    this.distribution = prepareFileSizeDistribution(connection)
  }

  invalidate(scanId: string): void {
    this.cache.invalidate(scanId)
  }

  clear(): void {
    this.cache.clear()
  }

  getCategories(scan: CompletedScan): InsightsCategories {
    this.cache.useScan(scan.id)
    return this.cache.getOrCompute('categories', () => this.fileTypes.getCategories(scan))
  }

  getSizeDistribution(scan: CompletedScan): InsightsSizeDistribution {
    this.cache.useScan(scan.id)
    return this.cache.getOrCompute('sizeDistribution', () => this.distribution(scan))
  }

  listExtensions(
    scan: CompletedScan,
    request: Required<InsightsExtensionRequest>
  ): InsightsExtensionPage {
    this.cache.useScan(scan.id)
    const cached = this.cache.get('extensions')
    if (cached) return extensionPage(cached, request, true)
    const { data, complete } = this.fileTypes.readExtensions(scan, request)
    if (complete) this.cache.set('extensions', data)
    return extensionPage(data, request, complete)
  }

  listLargest(
    scan: CompletedScan,
    type: InsightsRankedEntry['type'],
    request: Required<InsightsRankingRequest>
  ): InsightsRankingPage {
    const ranked = this.getTopEntries(scan, type)
    const { offset, limit } = request
    const entries = ranked.entries.slice(offset, offset + limit)
    const next = offset + entries.length
    return { ...ranked, entries, offset, limit, nextOffset: next < ranked.totalCount ? next : null }
  }

  getObservations(scan: CompletedScan): InsightsObservations {
    this.cache.useScan(scan.id)
    return this.cache.getOrCompute('observations', () =>
      buildObservations(
        { scanId: scan.id, summary: scan.summary },
        this.getSizeDistribution(scan),
        () => ({
          categories: this.getCategories(scan),
          files: this.getTopEntries(scan, 'file').entries,
          directories: this.getTopEntries(scan, 'directory').entries
        })
      )
    )
  }

  private getTopEntries(
    scan: CompletedScan,
    type: InsightsRankedEntry['type']
  ): InsightsRankingPage {
    this.cache.useScan(scan.id)
    const key = type === 'file' ? 'largestFiles' : 'largestDirectories'
    return this.cache.getOrCompute(key, () =>
      this.largestEntries.list(scan, type, {
        scanId: scan.id,
        offset: 0,
        limit: INSIGHTS_RANKING_LIMIT
      })
    )
  }
}
