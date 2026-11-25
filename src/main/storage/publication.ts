import type { DatabaseSync } from 'node:sqlite'
import type { CompletedScan } from './payloads'

/** Compare the persisted tree with scanner accounting while holding the publication transaction. */
export function prepareSnapshotValidation(
  connection: DatabaseSync
): (scan: CompletedScan) => bigint {
  const summary = connection.prepare(`
    WITH RECURSIVE reachable(id, type) AS (
      SELECT id, type FROM entries WHERE scan_id = $scanId AND parent_id IS NULL
      UNION ALL
      SELECT child.id, child.type
      FROM reachable AS parent
      JOIN entries AS child ON child.scan_id = $scanId AND child.parent_id = parent.id
      WHERE parent.type = 'directory'
    )
    SELECT COUNT(*) AS entry_count,
           (SELECT COUNT(*) FROM reachable) AS reachable_count,
           COUNT(*) FILTER (WHERE type = 'file') AS file_count,
           COUNT(*) FILTER (WHERE type = 'directory') AS directory_count,
           COALESCE(SUM(size_bytes) FILTER (WHERE type = 'file'), 0) AS total_bytes,
           COUNT(*) FILTER (WHERE type = 'unknown' OR (type = 'file' AND size_bytes IS NULL)) AS unknown_count
    FROM entries WHERE scan_id = $scanId
  `)
  summary.setReadBigInts(true)

  // Use direct child totals to check each persisted aggregate. The overall byte count above
  // sums logical file sizes only, so neither nesting nor directory totals inflate it.
  const invalidDirectory = connection.prepare(`
    SELECT directory.id FROM entries AS directory
    WHERE directory.scan_id = ? AND directory.type = 'directory'
      AND directory.aggregated_size_bytes IS NOT (
        SELECT COALESCE(SUM(CASE child.type
          WHEN 'file' THEN child.size_bytes
          WHEN 'directory' THEN child.aggregated_size_bytes
        END), 0)
        FROM entries AS child WHERE child.scan_id = directory.scan_id AND child.parent_id = directory.id
      )
    LIMIT 1
  `)

  return (scan) => {
    const facts = summary.get({ $scanId: scan.id })
    if (typeof facts?.entry_count !== 'bigint' || facts.entry_count !== facts.reachable_count) {
      throw new Error('Persisted entries are not all reachable from the scan root.')
    }
    if (
      facts.file_count !== BigInt(scan.summary.fileCount) ||
      facts.directory_count !== BigInt(scan.summary.directoryCount) ||
      facts.total_bytes !== BigInt(scan.summary.totalBytes)
    ) {
      throw new Error(
        'Persisted file count, directory count, or logical bytes differ from the scan summary.'
      )
    }
    if (facts.unknown_count !== 0n && scan.summary.errorCount === 0) {
      throw new Error('Unknown file metadata requires a reported scan error.')
    }
    const directory = invalidDirectory.get(scan.id)
    if (directory) {
      throw new Error(`Directory ${directory.id} is unfinished or has an inconsistent aggregate.`)
    }
    return facts.entry_count
  }
}
