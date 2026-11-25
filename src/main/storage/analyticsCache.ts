import type {
  InsightsCategories,
  InsightsObservations,
  InsightsRankingPage,
  InsightsSizeDistribution
} from '../../shared/insights'
import type { ExtensionAggregate } from './fileTypeAnalytics'

// Six fixed slots for one completed snapshot. Weights estimate retained JS values, not process RSS.
export const ANALYTICS_CACHE_BYTES = 512 * 1024
export const MAX_CACHED_EXTENSION_GROUPS = 1024
export const CACHED_EXTENSION_BASE_BYTES = 512
export const CACHED_EXTENSION_ROW_BYTES = 320

interface CachedAnalytics {
  categories: InsightsCategories
  extensions: ExtensionAggregate
  largestFiles: InsightsRankingPage
  largestDirectories: InsightsRankingPage
  sizeDistribution: InsightsSizeDistribution
  observations: InsightsObservations
}

type CacheKey = keyof CachedAnalytics
interface CacheItem {
  value: CachedAnalytics[CacheKey]
  bytes: number
}

function estimatedBytes(value: unknown): number {
  if (typeof value === 'string') return 32 + value.length * 2
  if (Array.isArray(value))
    return 64 + value.reduce<number>((n, item) => n + 8 + estimatedBytes(item), 0)
  if (value !== null && typeof value === 'object')
    return 64 + Object.values(value).reduce<number>((n, child) => n + 16 + estimatedBytes(child), 0)
  return 8
}

/** Evict the least recently used slot when a new cacheable aggregate would exceed the budget. */
export class AnalyticsCache {
  private readonly items = new Map<CacheKey, CacheItem>()
  private scanId: string | undefined
  private usedBytes = 0

  get estimatedBytes(): number {
    return this.usedBytes
  }

  useScan(scanId: string): void {
    if (this.scanId === scanId) return
    this.clear()
    this.scanId = scanId
  }

  invalidate(scanId: string): void {
    if (this.scanId === scanId) this.clear()
  }

  clear(): void {
    this.items.clear()
    this.usedBytes = 0
    this.scanId = undefined
  }

  get<K extends CacheKey>(key: K): CachedAnalytics[K] | undefined {
    const item = this.items.get(key)
    if (!item) return undefined
    this.items.delete(key)
    this.items.set(key, item)
    return item.value as CachedAnalytics[K]
  }

  set<K extends CacheKey>(key: K, value: CachedAnalytics[K]): void {
    if (this.scanId === undefined || value.scanId !== this.scanId) return
    const bytes =
      key === 'extensions'
        ? extensionBytes(value as ExtensionAggregate)
        : 128 + estimatedBytes(value)
    if (bytes > ANALYTICS_CACHE_BYTES) return
    this.remove(key)
    while (this.usedBytes + bytes > ANALYTICS_CACHE_BYTES) {
      this.remove(this.items.keys().next().value!)
    }
    this.items.set(key, { value, bytes })
    this.usedBytes += bytes
  }

  getOrCompute<K extends CacheKey>(key: K, compute: () => CachedAnalytics[K]): CachedAnalytics[K] {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const value = compute()
    this.set(key, value)
    return value
  }

  private remove(key: CacheKey): void {
    const entry = this.items.get(key)
    if (!entry) return
    this.items.delete(key)
    this.usedBytes -= entry.bytes
  }
}

function extensionBytes({ extensions, totalCount }: ExtensionAggregate): number {
  if (extensions.length !== totalCount || extensions.length > MAX_CACHED_EXTENSION_GROUPS)
    return Infinity
  return extensions.reduce(
    (n, { extension }) => n + CACHED_EXTENSION_ROW_BYTES + (extension?.length ?? 0) * 2,
    CACHED_EXTENSION_BASE_BYTES
  )
}
