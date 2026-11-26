import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite'
import type {
  ComparisonFileChange,
  ComparisonPathObservation,
  ComparisonSide,
  ComparisonSort
} from '../../shared/comparison'
import { observeComparisonPath } from '../comparison/classification'
import {
  isFileChangeClassification,
  type ComparisonFileResult,
  type ResolvedComparisonFileQuery
} from './comparisonFileContracts'
import type { CompatiblePair } from './comparisonMatchContracts'
import { MATCHED_ENTRIES, subtreeBindings, subtreeScope } from './comparisonSql'
import { MAX_SAFE_INTEGER, readEntryType, readText } from './entryRows'
import { readFilesystemText } from './filesystemText'
import { SnapshotAccessError } from './snapshotAccess'

const order: Readonly<Record<ComparisonSort, string>> = {
  path: 'path_key',
  'delta-asc': 'delta_bytes IS NULL, delta_bytes ASC, path_key',
  'delta-desc': 'delta_bytes IS NULL, delta_bytes DESC, path_key'
}

function knownModificationTime(column: 'baseline_modified_at' | 'target_modified_at'): string {
  // A canonical ISO string uniquely identifies the instant. +0 seconds normalizes invalid
  // month days and 24:00, so a round trip accepts only scanner-format timestamps.
  // For expanded years use the equivalent Gregorian year in SQLite's supported range.
  const calendar = `printf('%04d', 2000 + CAST(substr(${column}, 1, 7) AS INTEGER) % 400) || substr(${column}, 8)`
  const format = "'%Y-%m-%dT%H:%M:%fZ'"
  return `CASE length(${column})
    WHEN 24 THEN strftime(${format}, ${column}, '+0 seconds') IS ${column}
    WHEN 27 THEN
      ${column} GLOB '[+-][0-9][0-9][0-9][0-9][0-9][0-9]-*'
      AND (${column} BETWEEN '+010000-01-01T00:00:00.000Z' AND '+275760-09-13T00:00:00.000Z'
        OR substr(${column}, 1, 7) BETWEEN '-000001' AND '-271820'
        OR (substr(${column}, 1, 7) = '-271821' AND ${column} >= '-271821-04-20T00:00:00.000Z'))
      AND strftime(${format}, ${calendar}, '+0 seconds') IS (${calendar})
    ELSE 0
  END`
}

function logicalBytes(side: ComparisonSide): string {
  return `CASE
    WHEN ${side}_type = 'file' THEN ${side}_size
    WHEN ${side}_type IN ('directory', 'symlink', 'other') THEN 0
    WHEN ${side}_type IS NULL AND $${side}Complete = 1 THEN 0
  END`
}

/** One file-centric relation for pages, counts, and subsequent comparison summaries. */
export function comparisonFileChangesCte(subtree = false): string {
  const scope = subtree ? subtreeScope('matched.path_key') : "matched.path_key > X''"
  return `
    WITH observed_files AS (
      SELECT matched.path_key, baseline.id AS baseline_id, baseline.type AS baseline_type,
             baseline.parent_id AS baseline_parent_id, target.parent_id AS target_parent_id,
             baseline.size_bytes AS baseline_size, baseline.modified_at AS baseline_modified_at,
             target.id AS target_id, target.type AS target_type,
             target.size_bytes AS target_size, target.modified_at AS target_modified_at
      ${MATCHED_ENTRIES}
      WHERE ${scope}
        AND (baseline.type = 'file' OR target.type = 'file')
    ), evidence AS (
      SELECT *,
        baseline_size IS NOT NULL AND target_size IS NOT NULL AS sizes_known,
        ${knownModificationTime('baseline_modified_at')} AS baseline_time_known,
        ${knownModificationTime('target_modified_at')} AS target_time_known,
        ${logicalBytes('baseline')} AS baseline_bytes, ${logicalBytes('target')} AS target_bytes
      FROM observed_files
    ), reasons AS (
      SELECT *,
        CASE
          WHEN baseline_type = 'file' AND target_type = 'file' THEN
            CASE
              WHEN sizes_known AND baseline_size <> target_size THEN
                CASE WHEN baseline_modified_at IS NOT target_modified_at
                          AND baseline_time_known AND target_time_known
                     THEN 'size-and-modified-time-changed' ELSE 'size-changed' END
              WHEN baseline_modified_at IS target_modified_at THEN
                CASE WHEN sizes_known AND baseline_time_known THEN 'metadata-equal'
                     ELSE 'unknown-metadata' END
              WHEN baseline_time_known AND target_time_known THEN 'modified-time-changed'
              ELSE 'unknown-metadata'
            END
          WHEN baseline_type = 'unknown' OR target_type = 'unknown' THEN 'unknown-entry-type'
          WHEN baseline_id IS NOT NULL AND target_id IS NOT NULL THEN 'type-replacement'
          WHEN (baseline_id IS NULL AND $baselineComplete = 1)
            OR (target_id IS NULL AND $targetComplete = 1) THEN 'confirmed-absence'
          ELSE 'unknown-presence'
        END AS reason
      FROM evidence
    ), file_changes AS (
      SELECT *,
        CASE reason
          WHEN 'confirmed-absence' THEN CASE WHEN target_type = 'file' THEN 'added' ELSE 'removed' END
          WHEN 'type-replacement' THEN CASE WHEN target_type = 'file' THEN 'added' ELSE 'removed' END
          WHEN 'metadata-equal' THEN 'unchanged'
          WHEN 'size-and-modified-time-changed' THEN 'modified'
          WHEN 'size-changed' THEN 'modified'
          WHEN 'modified-time-changed' THEN 'modified'
          ELSE 'indeterminate'
        END AS kind,
        CASE WHEN baseline_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}
               AND target_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}
             THEN target_bytes - baseline_bytes END AS delta_bytes
      FROM reasons
    )
  `
}

export function readComparisonInteger(value: SQLOutputValue, signed: boolean): number {
  if (
    typeof value !== 'bigint' ||
    value < (signed ? -MAX_SAFE_INTEGER : 0n) ||
    value > MAX_SAFE_INTEGER
  )
    throw new SnapshotAccessError(
      'SIZE_OVERFLOW',
      'The file comparison exceeds the supported size.'
    )
  return Number(value)
}

function observation(
  row: Record<string, SQLOutputValue>,
  compatibility: CompatiblePair,
  side: ComparisonSide
): ComparisonPathObservation {
  const coverage = compatibility.coverage[side]
  const id = row[`${side}_id`]
  if (id === null) return observeComparisonPath(null, coverage)
  const bytes = row[`${side}_size`]
  const modifiedAt = row[`${side}_modified_at`]
  return observeComparisonPath(
    {
      scanId:
        side === 'baseline' ? compatibility.pair.baselineScanId : compatibility.pair.targetScanId,
      entryId: readText(id, 'comparison entry ID'),
      type: readEntryType(row[`${side}_type`]),
      sizeBytes: bytes === null ? null : readComparisonInteger(bytes, false),
      modifiedAt: modifiedAt === null ? null : readText(modifiedAt, 'comparison modification time')
    },
    coverage
  )
}

function readChange(
  row: Record<string, SQLOutputValue>,
  compatibility: CompatiblePair
): ComparisonFileChange {
  const classification = { kind: row.kind, reason: row.reason }
  if (!isFileChangeClassification(classification)) throw new Error('Invalid stored file change.')
  return {
    ...classification,
    relativePath: readFilesystemText(row.path_key, 'comparison key'),
    baseline: observation(row, compatibility, 'baseline'),
    target: observation(row, compatibility, 'target'),
    deltaBytes: row.delta_bytes === null ? null : readComparisonInteger(row.delta_bytes, true)
  }
}

function readStatement(connection: DatabaseSync, sql: string): StatementSync {
  const statement = connection.prepare(sql)
  statement.setReadBigInts(true)
  return statement
}

export function readComparisonFileChanges(
  connection: DatabaseSync,
  compatibility: CompatiblePair,
  { offset, limit, sort, kinds, relativeDirectory }: ResolvedComparisonFileQuery,
  unfilteredCount?: number
): ComparisonFileResult {
  const base = { pair: compatibility.pair, compatibility, offset, limit }
  if (kinds?.length === 0) return { ...base, items: [], totalCount: 0, nextOffset: null }

  const values: Record<string, SQLInputValue> = comparisonFileBindings(compatibility)
  if (relativeDirectory) Object.assign(values, subtreeBindings(relativeDirectory))
  const bindings = kinds?.map((kind, i) => {
    const binding = `$kind${i}`
    values[binding] = kind
    return binding
  })
  const filter = bindings ? `WHERE kind IN (${bindings.join(', ')})` : ''
  const relation = comparisonFileChangesCte(Boolean(relativeDirectory))
  let totalCount = !kinds && !relativeDirectory ? unfilteredCount : undefined
  if (totalCount === undefined) {
    const count = readStatement(
      connection,
      `${relation} SELECT COUNT(*) AS total FROM file_changes ${filter}`
    )
    totalCount = readComparisonInteger(count.get(values)?.total ?? null, false)
  }
  if (offset >= totalCount) return { ...base, items: [], totalCount, nextOffset: null }

  const select = readStatement(
    connection,
    `
    ${relation}
    SELECT path_key, baseline_id, baseline_type, baseline_size, baseline_modified_at,
           target_id, target_type, target_size, target_modified_at, kind, reason, delta_bytes
    FROM file_changes ${filter}
    ORDER BY ${order[sort]}
    LIMIT $limit OFFSET $offset
  `
  )
  const items = select
    .all({ ...values, $limit: limit, $offset: offset })
    .map((row) => readChange(row, compatibility))
  const end = offset + items.length
  return { ...base, items, totalCount, nextOffset: end < totalCount ? end : null }
}

export function comparisonFileBindings(
  compatibility: CompatiblePair
): Record<string, string | bigint> {
  return {
    $baseline: compatibility.pair.baselineScanId,
    $target: compatibility.pair.targetScanId,
    $baselineComplete: BigInt(compatibility.coverage.baseline === 'complete'),
    $targetComplete: BigInt(compatibility.coverage.target === 'complete')
  }
}
