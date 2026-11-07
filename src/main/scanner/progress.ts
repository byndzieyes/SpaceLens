import type { ScanProgress } from '../../shared/scan'
import type { ScanOutputEvent } from './summary'

function add(current: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER - current) {
    throw new RangeError('Scan progress must remain a non-negative safe integer.')
  }
  return current + amount
}

/**
 * Tracks the ordered, exactly-once scanner stream in O(1) space. Call after an
 * event is consumed; emit snapshots at batch boundaries, not per discovery.
 * Deduplication remains the producer's responsibility, as with scan summaries.
 */
export class ScanProgressTracker {
  private progress: ScanProgress

  constructor(scanId: string) {
    this.progress = {
      scanId,
      processedFileCount: 0,
      processedDirectoryCount: 0,
      processedBytes: 0,
      currentPath: null
    }
  }

  accept(event: ScanOutputEvent): void {
    const previous = this.progress
    if (event.type === 'summary') {
      if (event.scanId !== previous.scanId) throw new Error('Progress belongs to a different scan.')
      if (
        event.summary.fileCount !== previous.processedFileCount ||
        event.summary.directoryCount !== previous.processedDirectoryCount ||
        event.summary.totalBytes !== previous.processedBytes
      ) {
        throw new Error('Final scan progress differs from the scan summary.')
      }
      return
    }
    if (event.type === 'error') {
      this.progress = { ...previous, currentPath: event.error.path }
      return
    }
    const entry = event.entry
    if (entry.scanId !== previous.scanId) throw new Error('Progress belongs to a different scan.')
    const file = event.type === 'entry' && entry.type === 'file'
    const directory = event.type === 'entry' && entry.type === 'directory'
    this.progress = {
      ...previous,
      processedFileCount: add(previous.processedFileCount, file ? 1 : 0),
      processedDirectoryCount: add(previous.processedDirectoryCount, directory ? 1 : 0),
      processedBytes: add(previous.processedBytes, file ? (entry.sizeBytes ?? 0) : 0),
      currentPath: entry.path
    }
  }

  /** Independent serializable observations, not a successful-completion signal. */
  snapshot(): ScanProgress {
    return { ...this.progress }
  }
}
