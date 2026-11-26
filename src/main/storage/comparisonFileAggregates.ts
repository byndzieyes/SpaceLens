import { MAX_SAFE_INTEGER } from './entryRows'

/** An aggregate row for a single kind in any file-centric comparison scope. */
export const FILE_KIND_TOTALS_SQL = `
  COUNT(*) AS path_count, COUNT(delta_bytes) AS known_count,
  COUNT(*) FILTER (WHERE delta_bytes IS NULL) AS unknown_count,
  COALESCE(SUM(delta_bytes) FILTER (WHERE delta_bytes > 0), 0) AS positive_bytes,
  COALESCE(SUM(delta_bytes) FILTER (WHERE delta_bytes < 0), 0) AS negative_bytes,
  COALESCE(SUM(delta_bytes), 0) AS net_bytes,
  COUNT(*) FILTER (WHERE baseline_bytes NOT BETWEEN 0 AND ${MAX_SAFE_INTEGER}
                      OR target_bytes NOT BETWEEN 0 AND ${MAX_SAFE_INTEGER}) AS invalid_sizes
`
