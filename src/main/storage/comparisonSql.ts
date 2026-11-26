// Keep both readers on the same scan-scoped lookups over the path union.
export const MATCHED_ENTRIES = `
  FROM temp.comparison_paths AS matched
  LEFT JOIN main.entries AS baseline ON baseline.scan_id = $baseline AND baseline.id = matched.baseline_id
  LEFT JOIN main.entries AS target ON target.scan_id = $target AND target.id = matched.target_id
`
