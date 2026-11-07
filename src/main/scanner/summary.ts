import type { FileEntry, ScanSummary } from '../../shared/scan'
import type { ScannerAggregationEvent } from './aggregate'

/** Successful stream exhaustion, possibly with recoverable errors; not a stored ScanResult. */
export interface ScanSummaryEvent {
  readonly type: 'summary'
  readonly scanId: string
  /** Identity of the observed root only; does not promise retained/retrievable entries. */
  readonly rootEntryId: string
  readonly summary: ScanSummary
}

export type ScanOutputEvent = ScannerAggregationEvent | ScanSummaryEvent

function requireSize(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`)
  }
}

function add(current: number, amount: number, field: string): number {
  requireSize(amount, field)
  if (amount > Number.MAX_SAFE_INTEGER - current) {
    throw new RangeError(`${field} exceeds Number.MAX_SAFE_INTEGER.`)
  }
  return current + amount
}

/**
 * Wrap the scanner's ordered, exactly-once discovery/finalization stream.
 * Counts discoveries only; finalization replaces metadata rather than adding an
 * entry. Requires matching scan/root identity and a consistent finalized root.
 * Errors are scoped to this source (ScanError itself has no scan ID).
 *
 * Retains only counters and root identity (O(1)), not entries, errors, or a set of
 * seen IDs. Arbitrary replay/duplicate detection is the producer's responsibility.
 * The summary event appears only after successful exhaustion; fatal errors,
 * malformed/incomplete streams, and early consumer exit never yield a summary.
 */
export async function* summarizeScanEvents(
  events: AsyncIterable<ScannerAggregationEvent>,
  scanId: string
): AsyncGenerator<ScanOutputEvent, void, void> {
  if (scanId.trim().length === 0) throw new TypeError('Scan ID must not be empty.')

  let root: Pick<FileEntry, 'id' | 'path'> | null = null
  let rootTotal: number | null = null
  let fileCount = 0
  let directoryCount = 0
  let totalBytes = 0
  let errorCount = 0
  let hasUnknownMetadata = false

  for await (const event of events) {
    if (rootTotal !== null) throw new Error('Scanner emitted an event after root finalization.')
    if (event.type === 'error') {
      errorCount = add(errorCount, 1, 'errorCount')
      yield event
      continue
    }

    const entry = event.entry
    if (entry.scanId !== scanId) throw new Error('Scanner entry belongs to a different scan.')
    if (entry.id.length === 0) throw new Error('Scanner entry ID must not be empty.')
    if (entry.sizeBytes !== null) requireSize(entry.sizeBytes, 'sizeBytes')
    if (entry.type !== 'file' && entry.sizeBytes !== null) {
      throw new Error('Only regular files may have sizeBytes.')
    }

    if (event.type === 'entry') {
      if (entry.aggregatedSizeBytes !== null) {
        throw new Error('A discovery must not contain a finalized directory total.')
      }
      if (root === null) {
        if (entry.parentId !== null || entry.type !== 'directory') {
          throw new Error('First discovery must be the root directory.')
        }
        root = { id: entry.id, path: entry.path }
      } else if (entry.parentId === null || entry.id === root.id || entry.path === root.path) {
        throw new Error('Scanner emitted a duplicate or inconsistent root discovery.')
      }

      if (entry.type === 'file') {
        fileCount = add(fileCount, 1, 'fileCount')
        if (entry.sizeBytes === null) hasUnknownMetadata = true
        else totalBytes = add(totalBytes, entry.sizeBytes, 'totalBytes')
      } else if (entry.type === 'directory') {
        directoryCount = add(directoryCount, 1, 'directoryCount')
      } else if (entry.type === 'unknown') {
        hasUnknownMetadata = true
      }
    } else {
      if (root === null) throw new Error('Directory finalized before root discovery.')
      if (entry.type !== 'directory' || entry.aggregatedSizeBytes === null) {
        throw new Error('Directory finalization must include a directory total.')
      }
      requireSize(entry.aggregatedSizeBytes, 'aggregatedSizeBytes')
      if (entry.parentId === null || entry.id === root.id || entry.path === root.path) {
        if (entry.parentId !== null || entry.id !== root.id || entry.path !== root.path) {
          throw new Error('Finalized root identity differs from its discovery.')
        }
        rootTotal = entry.aggregatedSizeBytes
      }
    }
    yield event
  }

  if (root === null || rootTotal === null) {
    throw new Error('Scanner stream ended without a discovered and finalized root.')
  }
  if (rootTotal !== totalBytes) {
    throw new Error('Finalized root total differs from known regular-file bytes.')
  }
  if (hasUnknownMetadata && errorCount === 0) {
    throw new Error('Unknown file metadata was not accompanied by a reported error.')
  }
  yield {
    type: 'summary',
    scanId,
    rootEntryId: root.id,
    summary: { fileCount, directoryCount, totalBytes, errorCount }
  }
}
