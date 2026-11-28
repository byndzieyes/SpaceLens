import type { SQLInputValue } from 'node:sqlite'
import type { ComparisonPathKey } from '../../shared/comparison'
import { bindFilesystemText } from './filesystemText'

// Keep all readers on the same scan-scoped lookups over the path union.
export function matchedEntries(candidate = false): string {
  return `
  FROM temp.${candidate ? 'comparison_candidate_paths' : 'comparison_paths'} AS matched
  LEFT JOIN main.entries AS baseline ON baseline.scan_id = $baseline AND baseline.id = matched.baseline_id
  LEFT JOIN main.entries AS target ON target.scan_id = $target AND target.id = matched.target_id
`
}

export const MATCHED_ENTRIES = matchedEntries()

export function subtreeScope(column: 'matched.path_key' | 'path_key'): string {
  return `${column} >= $directory AND ${column} < $directoryEnd
          AND (${column} = $directory OR ${column} >= $descendants)`
}

export function subtreeBindings(
  relativeDirectory: ComparisonPathKey
): Record<string, SQLInputValue> {
  return {
    $directory: bindFilesystemText(relativeDirectory),
    $descendants: bindFilesystemText(relativeDirectory + '/'),
    // '0' immediately follows '/' in UTF-16, bounding all descendants of the prefix.
    $directoryEnd: bindFilesystemText(relativeDirectory + '0')
  }
}
