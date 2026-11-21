import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite'
import {
  INSIGHTS_FILE_CATEGORIES,
  type InsightsCategories,
  type InsightsExtensionPage,
  type InsightsExtensionRequest,
  type InsightsExtensionRow,
  type InsightsFileBreakdown,
  type InsightsFileTotals
} from '../../shared/insights'
import { classifyExtension, normalizedExtension } from '../insights/fileClassification'
import {
  ANALYTICS_CACHE_BYTES,
  CACHED_EXTENSION_BASE_BYTES,
  CACHED_EXTENSION_ROW_BYTES,
  MAX_CACHED_EXTENSION_GROUPS
} from './analyticsCache'
import { aggregateInteger, readFileAggregateRows } from './fileAggregation'
import { bindFilesystemText, readFilesystemText } from './filesystemText'
import type { CompletedScan } from './payloads'

const FILE_TOTALS = `COUNT(*) AS file_count,
  COALESCE(SUM(size_bytes), 0) AS known_bytes,
  COUNT(*) FILTER (WHERE size_bytes IS NULL) AS unknown_count`
const FILES_IN_SCAN = "FROM entries WHERE scan_id = $scanId AND type = 'file'"
const EXTENSION_ORDER = 'known_bytes DESC, file_count DESC, extension ASC NULLS FIRST'

const INSIGHTS_CATEGORY_SQL = `
  WITH grouped AS (
    SELECT spacelens_file_category(name) AS category, ${FILE_TOTALS}
    ${FILES_IN_SCAN} GROUP BY category
  )
  SELECT *,
         SUM(file_count) OVER () AS total_files,
         SUM(known_bytes) OVER () AS total_bytes,
         SUM(unknown_count) OVER () AS total_unknown
  FROM grouped
`

const INSIGHTS_EXTENSION_SQL = `
  WITH grouped AS MATERIALIZED (
    SELECT spacelens_file_extension(name) AS extension, ${FILE_TOTALS}
    ${FILES_IN_SCAN} GROUP BY extension
  ), counts AS (
    SELECT COUNT(*) AS group_count,
           COALESCE(SUM(file_count), 0) AS total_files,
           COALESCE(SUM(known_bytes), 0) AS total_bytes,
           COALESCE(SUM(unknown_count), 0) AS total_unknown,
           COALESCE(SUM(MIN(COALESCE(length(extension), 0), $cacheBytes + 1)), 0) AS text_bytes
    FROM grouped
  ), totals AS MATERIALIZED (
    SELECT *, group_count <= $maxGroups AND
             $baseBytes + group_count * $rowBytes + text_bytes <= $cacheBytes AS cacheable
    FROM counts
  ), page AS (
    SELECT * FROM grouped ORDER BY ${EXTENSION_ORDER}
    LIMIT CASE WHEN (SELECT cacheable FROM totals) THEN $maxGroups ELSE $limit END
    OFFSET CASE WHEN (SELECT cacheable FROM totals) THEN 0 ELSE $offset END
  )
  SELECT totals.*, page.* FROM totals LEFT JOIN page ON TRUE
  ORDER BY ${EXTENSION_ORDER}
`

function readGroup(row: Record<string, SQLOutputValue>): InsightsFileTotals {
  return {
    fileCount: aggregateInteger(row.file_count),
    knownBytes: aggregateInteger(row.known_bytes),
    unknownSizeCount: aggregateInteger(row.unknown_count)
  }
}

function breakdown(
  scan: CompletedScan,
  row: Record<string, SQLOutputValue> | undefined
): InsightsFileBreakdown {
  const totals = {
    fileCount: aggregateInteger(row?.total_files ?? 0n),
    knownBytes: aggregateInteger(row?.total_bytes ?? 0n),
    unknownSizeCount: aggregateInteger(row?.total_unknown ?? 0n)
  }
  if (
    totals.fileCount !== scan.summary.fileCount ||
    totals.knownBytes !== scan.summary.totalBytes ||
    totals.unknownSizeCount > totals.fileCount ||
    (totals.unknownSizeCount > 0 && scan.summary.errorCount === 0)
  ) {
    throw new Error('File breakdown differs from the published scan summary.')
  }
  return { scanId: scan.id, incomplete: scan.summary.errorCount > 0, totals }
}

export interface ExtensionAggregate extends InsightsFileBreakdown {
  readonly extensions: readonly InsightsExtensionRow[]
  readonly totalCount: number
}

export function extensionPage(
  aggregate: ExtensionAggregate,
  { offset, limit }: Required<InsightsExtensionRequest>,
  complete: boolean
): InsightsExtensionPage {
  const extensions = complete
    ? aggregate.extensions.slice(offset, offset + limit)
    : aggregate.extensions
  const next = offset + extensions.length
  return { ...aggregate, extensions, nextOffset: next < aggregate.totalCount ? next : null }
}

export class FileTypeAnalytics {
  private readonly categories: StatementSync
  private readonly extensions: StatementSync

  constructor(connection: DatabaseSync) {
    connection.function('spacelens_file_category', { deterministic: true }, (name) =>
      classifyExtension(normalizedExtension(readFilesystemText(name, 'name')))
    )
    // Group and sort normalized UTF-16BE keys without round-tripping them through SQLite TEXT.
    connection.function('spacelens_file_extension', { deterministic: true }, (name) => {
      const extension = normalizedExtension(readFilesystemText(name, 'name'))
      return extension === null ? null : bindFilesystemText(extension)
    })
    this.categories = connection.prepare(INSIGHTS_CATEGORY_SQL)
    this.categories.setReadBigInts(true)
    this.extensions = connection.prepare(INSIGHTS_EXTENSION_SQL)
    this.extensions.setReadBigInts(true)
  }

  getCategories(scan: CompletedScan): InsightsCategories {
    const rows = readFileAggregateRows(this.categories, { $scanId: scan.id })
    return {
      ...breakdown(scan, rows[0]),
      categories: INSIGHTS_FILE_CATEGORIES.flatMap((category) => {
        const row = rows.find((group) => group.category === category)
        return row ? [{ category, ...readGroup(row) }] : []
      })
    }
  }

  readExtensions(
    scan: CompletedScan,
    { offset, limit }: Required<InsightsExtensionRequest>
  ): { data: ExtensionAggregate; complete: boolean } {
    const rows = readFileAggregateRows(this.extensions, {
      $scanId: scan.id,
      $limit: BigInt(limit),
      $offset: BigInt(offset),
      $maxGroups: BigInt(MAX_CACHED_EXTENSION_GROUPS),
      $baseBytes: BigInt(CACHED_EXTENSION_BASE_BYTES),
      $rowBytes: BigInt(CACHED_EXTENSION_ROW_BYTES),
      $cacheBytes: BigInt(ANALYTICS_CACHE_BYTES)
    })
    const totals = rows[0]
    const totalCount = aggregateInteger(totals.group_count)
    // A NULL file_count indicates the sentinel row from the LEFT JOIN, even past the last page.
    const extensions =
      totals.file_count === null
        ? []
        : rows.map((row) => {
            const extension =
              row.extension === null ? null : readFilesystemText(row.extension, 'extension')
            return { extension, category: classifyExtension(extension), ...readGroup(row) }
          })
    return {
      data: { ...breakdown(scan, totals), extensions, totalCount },
      complete: totals.cacheable === 1n
    }
  }
}
