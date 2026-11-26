import {
  DEFAULT_COMPARISON_PAGE_SIZE,
  MAX_COMPARISON_PAGE_SIZE,
  type CompatiblePair,
  type ComparisonErrorCode,
  type ComparisonPair,
  type ComparisonPathKey,
  type ComparisonWarning
} from '../../shared/comparison'
import type { FileEntry } from '../../shared/scan'
import { integer, isSnapshotId, isStorageEntry, nonempty, record } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'

/** Internal inspection. The cursor is the last canonical key from the same directional pair. */
export interface ComparisonMatchQuery extends ComparisonPair {
  readonly after?: ComparisonPathKey
  readonly limit?: number
}

export type ResolvedComparisonMatchQuery = ComparisonMatchQuery & { readonly limit: number }
export type { CompatiblePair } from '../../shared/comparison'

export interface ComparisonMatchRow {
  readonly relativePath: ComparisonPathKey
  /** Null means there was no observed entry, regardless of coverage. */
  readonly baseline: FileEntry | null
  readonly target: FileEntry | null
}

export interface ComparisonMatchPage {
  readonly compatibility: CompatiblePair
  readonly rows: readonly ComparisonMatchRow[]
  readonly limit: number
  readonly nextAfter: ComparisonPathKey | null
}

export class ComparisonStorageError extends Error {
  constructor(
    readonly code: Extract<
      ComparisonErrorCode,
      'INCOMPATIBLE_SNAPSHOTS' | 'INVALID_COMPARISON_PATH' | 'AMBIGUOUS_COMPARISON_PATH'
    >,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ComparisonStorageError'
  }
}

export function readComparisonMatchQuery(value: unknown): ResolvedComparisonMatchQuery {
  if (
    record(value) &&
    Object.keys(value).every((key) =>
      ['baselineScanId', 'targetScanId', 'after', 'limit'].includes(key)
    ) &&
    Object.hasOwn(value, 'baselineScanId') &&
    Object.hasOwn(value, 'targetScanId') &&
    isSnapshotId(value.baselineScanId) &&
    isSnapshotId(value.targetScanId)
  ) {
    const limit = Object.hasOwn(value, 'limit') ? value.limit : DEFAULT_COMPARISON_PAGE_SIZE
    const after = Object.hasOwn(value, 'after') ? value.after : null
    if (
      integer(limit) &&
      limit >= 1 &&
      limit <= MAX_COMPARISON_PAGE_SIZE &&
      (Object.hasOwn(value, 'after') ? typeof after === 'string' && !after.includes('\0') : true)
    ) {
      return {
        baselineScanId: value.baselineScanId,
        targetScanId: value.targetScanId,
        limit,
        ...(typeof after === 'string' && { after })
      }
    }
  }
  throw new SnapshotAccessError(
    'INVALID_REQUEST',
    'A comparison requires two IDs and bounded pagination.'
  )
}

export function isCompatiblePair(value: unknown): value is CompatiblePair {
  if (!record(value) || !record(value.pair) || !record(value.coverage)) return false
  const { baselineScanId, targetScanId } = value.pair
  if (
    !isSnapshotId(baselineScanId) ||
    !isSnapshotId(targetScanId) ||
    baselineScanId === targetScanId ||
    !nonempty(value.normalizedRoot) ||
    (value.pathStyle !== 'posix' && value.pathStyle !== 'win32')
  )
    return false

  const expectedWarnings: ComparisonWarning[] = []
  for (const side of ['baseline', 'target'] as const) {
    const coverage = value.coverage[side]
    if (coverage === 'incomplete') expectedWarnings.push({ code: 'INCOMPLETE_COVERAGE', side })
    else if (coverage === 'unknown')
      expectedWarnings.push({
        code: 'INSUFFICIENT_COMPATIBILITY_METADATA',
        field: 'coverage',
        side
      })
    else if (coverage !== 'complete') return false
  }
  if (expectedWarnings.length === 0) return value.status === 'compatible'
  const { warnings } = value
  return (
    value.status === 'compatible-with-warnings' &&
    Array.isArray(warnings) &&
    warnings.length === expectedWarnings.length &&
    expectedWarnings.every((expected, index) => {
      const warning: unknown = warnings[index]
      return (
        record(warning) &&
        warning.code === expected.code &&
        warning.side === expected.side &&
        warning.field === ('field' in expected ? expected.field : undefined)
      )
    })
  )
}

function isMatchedEntry(value: unknown, scanId: string, isRoot: boolean): value is FileEntry {
  return (
    isStorageEntry(value) &&
    value.scanId === scanId &&
    isSnapshotId(value.id) &&
    (isRoot ? value.parentId === null && value.type === 'directory' : isSnapshotId(value.parentId))
  )
}

export function isComparisonMatchPage(value: unknown): value is ComparisonMatchPage {
  if (
    !record(value) ||
    !isCompatiblePair(value.compatibility) ||
    !integer(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_COMPARISON_PAGE_SIZE ||
    !Array.isArray(value.rows) ||
    value.rows.length > value.limit
  )
    return false

  const { baselineScanId, targetScanId } = value.compatibility.pair
  let previous: string | undefined
  for (const row of value.rows as unknown[]) {
    if (!record(row) || typeof row.relativePath !== 'string') return false
    const { relativePath, baseline, target } = row
    const isRoot = relativePath === ''
    if (
      relativePath.includes('\0') ||
      (previous !== undefined && relativePath <= previous) ||
      (baseline === null && target === null) ||
      (isRoot && (baseline === null || target === null)) ||
      (baseline !== null && !isMatchedEntry(baseline, baselineScanId, isRoot)) ||
      (target !== null && !isMatchedEntry(target, targetScanId, isRoot))
    )
      return false
    previous = relativePath
  }
  return (
    value.nextAfter === null ||
    (typeof value.nextAfter === 'string' &&
      value.rows.length === value.limit &&
      value.nextAfter === previous)
  )
}
