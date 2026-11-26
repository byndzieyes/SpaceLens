import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type {
  ComparisonDirectoryChange,
  ComparisonDirectoryObservation,
  ComparisonFileSummary,
  ComparisonSide,
  ComparisonSort
} from '../../shared/comparison'
import type { CompletedScanMetadata } from '../../shared/scan'
import {
  type ComparisonDirectoryResult,
  type ResolvedComparisonDirectoryQuery
} from './comparisonDirectoryContracts'
import { FILE_KIND_TOTALS_SQL } from './comparisonFileAggregates'
import {
  comparisonFileBindings,
  comparisonFileChangesCte,
  readComparisonInteger
} from './comparisonFileChanges'
import { isChangeKind } from './comparisonFileContracts'
import type { CompatiblePair } from './comparisonMatchContracts'
import { MATCHED_ENTRIES, subtreeBindings, subtreeScope } from './comparisonSql'
import { isComparisonFileSummary } from './comparisonSummaryContracts'
import { MAX_SAFE_INTEGER, readText } from './entryRows'
import { readFilesystemText } from './filesystemText'
import { SnapshotAccessError } from './snapshotAccess'

const DIRECTORY_BATCH_SIZE = 512
const kinds = ['added', 'removed', 'modified', 'unchanged', 'indeterminate'] as const
const totals = [
  ...kinds,
  'path_count',
  'known_count',
  'unknown_count',
  'positive_bytes',
  'negative_bytes',
  'net_bytes',
  'confirmed_net',
  'confirmed_unknown',
  'invalid_sizes'
]
const order: Readonly<Record<ComparisonSort, string>> = {
  path: 'path_key',
  'delta-asc': 'observed_delta IS NULL, observed_delta ASC, path_key',
  'delta-desc': 'observed_delta IS NULL, observed_delta DESC, path_key'
}

function presence(side: ComparisonSide): string {
  return `CASE
    WHEN ${side}.type = 'directory' THEN 'present'
    WHEN ${side}.type = 'unknown' OR (${side}.id IS NULL AND $${side}Complete = 0) THEN 'unknown'
    ELSE 'absent'
  END`
}

function sizeOverflow(): SnapshotAccessError {
  return new SnapshotAccessError(
    'SIZE_OVERFLOW',
    'Directory comparison exceeds the supported size.'
  )
}

export function prepareComparisonDirectories(
  connection: DatabaseSync,
  compatibility: CompatiblePair,
  baseline: CompletedScanMetadata,
  target: CompletedScanMetadata,
  summaryFiles: ComparisonFileSummary | undefined
): void {
  try {
    prepareDirectories(connection, compatibility, baseline, target, summaryFiles)
  } catch (error) {
    // SQLite SUM can overflow int64. An overflowing scalar addition becomes REAL, which
    // cannot be written to the STRICT INTEGER totals during the bottom-up pass.
    if (
      error instanceof Error &&
      (error.message === 'integer overflow' ||
        error.message.startsWith(
          'cannot store REAL value in INTEGER column comparison_directories.'
        ))
    )
      throw sizeOverflow()
    throw error
  }
}

function prepareDirectories(
  connection: DatabaseSync,
  compatibility: CompatiblePair,
  baseline: CompletedScanMetadata,
  target: CompletedScanMetadata,
  summaryFiles: ComparisonFileSummary | undefined
): void {
  connection.exec(`
    CREATE TEMP TABLE IF NOT EXISTS comparison_directories (
      path_key BLOB PRIMARY KEY,
      parent_key BLOB,
      baseline_id TEXT,
      target_id TEXT,
      parent_id TEXT,
      baseline_presence TEXT NOT NULL,
      target_presence TEXT NOT NULL,
      baseline_bytes INTEGER,
      target_bytes INTEGER,
      observed_delta INTEGER,
      type_replacement INTEGER NOT NULL,
      kind TEXT NOT NULL,
      uncertain INTEGER NOT NULL,
      structural_change INTEGER NOT NULL DEFAULT 0,
      ${totals.map((column) => `${column} INTEGER NOT NULL DEFAULT 0`).join(',\n')}
    ) STRICT, WITHOUT ROWID;
    CREATE UNIQUE INDEX IF NOT EXISTS temp.comparison_dirs_baseline
      ON comparison_directories(baseline_id) WHERE baseline_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS temp.comparison_dirs_target
      ON comparison_directories(target_id) WHERE target_id IS NOT NULL;
    DELETE FROM temp.comparison_directories;
  `)
  const bindings = comparisonFileBindings(compatibility)
  connection
    .prepare(
      `
    WITH directory_observations AS (
      SELECT matched.path_key,
        CASE WHEN baseline.type = 'directory' THEN baseline.id END AS baseline_id,
        CASE WHEN target.type = 'directory' THEN target.id END AS target_id,
        CASE WHEN baseline.type = 'directory' THEN baseline.parent_id ELSE target.parent_id END AS parent_id,
        ${presence('baseline')} AS baseline_presence,
        ${presence('target')} AS target_presence,
        baseline.aggregated_size_bytes AS baseline_size,
        target.aggregated_size_bytes AS target_size,
        CASE WHEN baseline.type IN ('file', 'symlink', 'other')
               OR target.type IN ('file', 'symlink', 'other') THEN 1 ELSE 0 END AS replacement
      ${MATCHED_ENTRIES}
      WHERE baseline.type = 'directory' OR target.type = 'directory'
    ), directory_sizes AS (
      SELECT *,
        CASE WHEN baseline_presence = 'absent' THEN 0 ELSE baseline_size END AS baseline_bytes,
        CASE WHEN target_presence = 'absent' THEN 0 ELSE target_size END AS target_bytes
      FROM directory_observations
    )
    INSERT INTO temp.comparison_directories (
      path_key, baseline_id, target_id, parent_id, baseline_presence, target_presence,
      baseline_bytes, target_bytes, observed_delta, type_replacement, kind, uncertain
    )
    SELECT path_key, baseline_id, target_id, parent_id, baseline_presence, target_presence,
      baseline_bytes, target_bytes,
      CASE WHEN baseline_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}
             AND target_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}
           THEN target_bytes - baseline_bytes END,
      replacement,
      CASE WHEN baseline_presence = 'absent' THEN 'added'
           WHEN target_presence = 'absent' THEN 'removed'
           WHEN baseline_presence = 'unknown' OR target_presence = 'unknown' THEN 'indeterminate'
           ELSE 'unchanged' END,
      CASE WHEN $baselineComplete = 0 OR $targetComplete = 0
             OR baseline_bytes IS NULL OR target_bytes IS NULL THEN 1 ELSE 0 END
    FROM directory_sizes
  `
    )
    .run(bindings)
  connection.exec(`
    UPDATE temp.comparison_directories AS directory
    SET parent_key = CASE WHEN baseline_id IS NOT NULL
      THEN (SELECT path_key FROM temp.comparison_directories WHERE baseline_id = directory.parent_id)
      ELSE (SELECT path_key FROM temp.comparison_directories WHERE target_id = directory.parent_id)
    END
    WHERE path_key > X'';
  `)
  if (
    connection
      .prepare(
        `
    SELECT 1 FROM temp.comparison_directories
    WHERE path_key > X'' AND (parent_key IS NULL OR parent_key >= path_key) LIMIT 1
  `
      )
      .get()
  )
    throw new Error('Invalid comparison directory parent.')

  // An exact-path replacement stays with the file's parent. Every eligible file is assigned
  // to just one immediate parent before any subtree totals are propagated.
  connection
    .prepare(
      `
    ${comparisonFileChangesCte()},
    direct_files AS (
      SELECT file_changes.*, COALESCE(baseline_dir.path_key, target_dir.path_key) AS directory_key
      FROM file_changes
      LEFT JOIN temp.comparison_directories AS baseline_dir ON baseline_dir.baseline_id = baseline_parent_id
      LEFT JOIN temp.comparison_directories AS target_dir
        ON baseline_parent_id IS NULL AND target_dir.target_id = target_parent_id
    ), direct_file_kinds AS (
      SELECT directory_key, kind, ${FILE_KIND_TOTALS_SQL}
      FROM direct_files
      GROUP BY directory_key, kind
    ), direct_file_totals AS (
      SELECT directory_key, ${kinds.map((kind) => `COALESCE(SUM(path_count) FILTER (WHERE kind = '${kind}'), 0) AS ${kind}`).join(',\n')},
        SUM(path_count) AS path_count, SUM(known_count) AS known_count, SUM(unknown_count) AS unknown_count,
        SUM(positive_bytes) AS positive_bytes, SUM(negative_bytes) AS negative_bytes,
        SUM(net_bytes) AS net_bytes, SUM(invalid_sizes) AS invalid_sizes,
        COALESCE(SUM(net_bytes) FILTER (WHERE kind <> 'indeterminate'), 0) AS confirmed_net,
        COALESCE(SUM(unknown_count) FILTER (WHERE kind <> 'indeterminate'), 0) AS confirmed_unknown
      FROM direct_file_kinds
      GROUP BY directory_key
    )
    UPDATE temp.comparison_directories AS directory
    SET ${totals.map((column) => `${column} = direct.${column}`).join(',\n')}
    FROM direct_file_totals AS direct
    WHERE directory.path_key = direct.directory_key
  `
    )
    .run(bindings)
  rollUpDirectories(connection)
  connection.exec(`
    UPDATE temp.comparison_directories
    SET uncertain = MAX(uncertain, unknown_count > 0, indeterminate > 0),
      kind = CASE
        WHEN kind <> 'unchanged' THEN kind
        WHEN added > 0 OR removed > 0 OR modified > 0 OR structural_change = 1 THEN 'modified'
        WHEN uncertain = 1 OR unknown_count > 0 OR indeterminate > 0 THEN 'indeterminate'
        ELSE 'unchanged'
      END;
  `)
  if (
    connection
      .prepare(
        `
    SELECT 1 FROM temp.comparison_directories
    WHERE baseline_bytes NOT BETWEEN 0 AND ${MAX_SAFE_INTEGER}
       OR target_bytes NOT BETWEEN 0 AND ${MAX_SAFE_INTEGER} LIMIT 1
  `
      )
      .get()
  )
    throw sizeOverflow()
  const root = integerStatement(
    connection,
    "SELECT * FROM temp.comparison_directories WHERE path_key = X''"
  ).get()
  if (!root) throw new Error('Missing comparison directory root.')
  if (root.invalid_sizes !== 0n) throw sizeOverflow()
  const files = readSubtreeFiles(root)
  if (
    root.baseline_bytes !== BigInt(baseline.summary.totalBytes) ||
    root.target_bytes !== BigInt(target.summary.totalBytes) ||
    files.positiveDeltaBytes > target.summary.totalBytes ||
    files.negativeDeltaBytes < -baseline.summary.totalBytes ||
    (summaryFiles && !isDeepStrictEqual(files, summaryFiles))
  )
    throw new Error('Inconsistent comparison root totals.')

  if (
    compatibility.coverage.baseline === 'complete' &&
    compatibility.coverage.target === 'complete' &&
    connection
      .prepare(
        `
        SELECT 1 FROM temp.comparison_directories
        WHERE unknown_count = 0 AND observed_delta IS NOT NULL AND net_bytes <> observed_delta
        LIMIT 1
      `
      )
      .get()
  )
    throw new Error('Inconsistent observed and file-level directory totals.')
}

function rollUpDirectories(connection: DatabaseSync): void {
  const first = connection.prepare(`
    SELECT path_key FROM temp.comparison_directories
    WHERE path_key > X'' ORDER BY path_key DESC LIMIT ${DIRECTORY_BATCH_SIZE}
  `)
  const next = connection.prepare(`
    SELECT path_key FROM temp.comparison_directories
    WHERE path_key > X'' AND path_key < ? ORDER BY path_key DESC LIMIT ${DIRECTORY_BATCH_SIZE}
  `)
  const addToParent = connection.prepare(`
    UPDATE temp.comparison_directories AS parent
    SET ${totals.map((column) => `${column} = parent.${column} + child.${column}`).join(',\n')},
      structural_change = MAX(parent.structural_change, child.structural_change, child.kind IN ('added', 'removed')),
      uncertain = MAX(parent.uncertain, child.uncertain)
    FROM temp.comparison_directories AS child
    WHERE child.path_key = ? AND parent.path_key = child.parent_key
  `)
  // Every parent is a proper prefix and follows all its descendants in descending BLOB order.
  let page = first.all()
  while (page.length) {
    let lastKey: Uint8Array | undefined
    for (const { path_key } of page) {
      if (!(path_key instanceof Uint8Array)) throw new Error('Invalid comparison directory key.')
      if (Number(addToParent.run(path_key).changes) !== 1)
        throw new Error('Invalid comparison directory parent.')
      lastKey = path_key
    }
    if (page.length < DIRECTORY_BATCH_SIZE) break
    page = next.all(lastKey!)
  }
}

function integerStatement(connection: DatabaseSync, sql: string): StatementSync {
  const statement = connection.prepare(sql)
  statement.setReadBigInts(true)
  return statement
}

export function reconcileDirectoryRoot(
  connection: DatabaseSync,
  files: ComparisonFileSummary
): void {
  const root = integerStatement(
    connection,
    "SELECT * FROM temp.comparison_directories WHERE path_key = X''"
  ).get()
  if (!root || !isDeepStrictEqual(readSubtreeFiles(root), files))
    throw new Error('Inconsistent comparison root totals.')
}

function readSubtreeFiles(row: Record<string, SQLOutputValue>): ComparisonFileSummary {
  const files: ComparisonFileSummary = {
    counts: {
      added: readComparisonInteger(row.added, false),
      removed: readComparisonInteger(row.removed, false),
      modified: readComparisonInteger(row.modified, false),
      unchanged: readComparisonInteger(row.unchanged, false),
      indeterminate: readComparisonInteger(row.indeterminate, false)
    },
    totalCount: readComparisonInteger(row.path_count, false),
    knownDeltaCount: readComparisonInteger(row.known_count, false),
    unknownDeltaCount: readComparisonInteger(row.unknown_count, false),
    positiveDeltaBytes: readComparisonInteger(row.positive_bytes, false),
    negativeDeltaBytes: readComparisonInteger(row.negative_bytes, true),
    netKnownDeltaBytes: readComparisonInteger(row.net_bytes, true),
    confirmedKnownDeltaBytes: readComparisonInteger(row.confirmed_net, true),
    confirmedUnknownDeltaCount: readComparisonInteger(row.confirmed_unknown, false)
  }
  if (!isComparisonFileSummary(files)) throw new Error('Inconsistent directory file totals.')
  return files
}

function observation(
  row: Record<string, SQLOutputValue>,
  side: ComparisonSide,
  scanId: string
): ComparisonDirectoryObservation {
  const presence = row[`${side}_presence`]
  if (presence === 'absent' || presence === 'unknown') return { presence }
  if (presence !== 'present') throw new Error('Invalid comparison directory observation.')
  const bytes = row[`${side}_bytes`]
  return {
    presence,
    entry: { type: 'directory', scanId, entryId: readText(row[`${side}_id`], 'directory ID') },
    observedBytes: bytes === null ? null : readComparisonInteger(bytes, false)
  }
}

function readDirectory(
  row: Record<string, SQLOutputValue>,
  compatibility: CompatiblePair
): ComparisonDirectoryChange {
  if (!isChangeKind(row.kind)) throw new Error('Invalid comparison directory change.')
  return {
    relativePath: readFilesystemText(row.path_key, 'comparison directory key'),
    kind: row.kind,
    baseline: observation(row, 'baseline', compatibility.pair.baselineScanId),
    target: observation(row, 'target', compatibility.pair.targetScanId),
    observedDeltaBytes:
      row.observed_delta === null ? null : readComparisonInteger(row.observed_delta, true),
    typeReplacement: row.type_replacement === 1n,
    uncertain: row.uncertain === 1n,
    subtreeFiles: readSubtreeFiles(row)
  }
}

export function listComparisonDirectories(
  connection: DatabaseSync,
  compatibility: CompatiblePair,
  { offset, limit, sort, kinds, relativeDirectory, includeRoot }: ResolvedComparisonDirectoryQuery
): ComparisonDirectoryResult {
  const base = { pair: compatibility.pair, compatibility, offset, limit }
  if (kinds?.length === 0) return { ...base, items: [], totalCount: 0, nextOffset: null }
  const bindings: Record<string, SQLInputValue> = relativeDirectory
    ? subtreeBindings(relativeDirectory)
    : {}
  const scope = relativeDirectory ? subtreeScope('path_key') : includeRoot ? '1' : "path_key > X''"
  const filter = kinds?.map((kind, index) => {
    const name = `$kind${index}`
    bindings[name] = kind
    return name
  })
  const rows = `FROM temp.comparison_directories WHERE ${scope}${filter ? ` AND kind IN (${filter.join(', ')})` : ''}`
  const count = integerStatement(connection, `SELECT COUNT(*) AS total ${rows}`).get(bindings)
  const totalCount = readComparisonInteger(count?.total ?? null, false)
  if (offset >= totalCount) return { ...base, items: [], totalCount, nextOffset: null }
  const items = integerStatement(
    connection,
    `
    SELECT * ${rows} ORDER BY ${order[sort]} LIMIT $limit OFFSET $offset
  `
  )
    .all({ ...bindings, $limit: limit, $offset: offset })
    .map((row) => readDirectory(row, compatibility))
  const end = offset + items.length
  return { ...base, items, totalCount, nextOffset: end < totalCount ? end : null }
}
