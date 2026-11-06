import type { FileEntry } from '../../shared/scan'
import type { TraversalEvent } from './traverse'

export type DirectoryAggregationEvent =
  | { readonly type: 'entry'; readonly entry: FileEntry }
  | { readonly type: 'directory-finalized'; readonly entry: FileEntry }

export type ScannerAggregationEvent = DirectoryAggregationEvent | TraversalEvent

interface DirectoryTotal {
  readonly entry: FileEntry
  bytes: number
}

function addBytes(total: number, bytes: number, path: string): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError(`Invalid logical byte size at ${path}`)
  }
  if (bytes > Number.MAX_SAFE_INTEGER - total) {
    throw new RangeError(`Directory size exceeds Number.MAX_SAFE_INTEGER at ${path}`)
  }
  return total + bytes
}

function finishDirectory(stack: DirectoryTotal[]): FileEntry {
  const directory = stack.pop()!
  const parent = stack[stack.length - 1]
  if (parent) {
    parent.bytes = addBytes(parent.bytes, directory.bytes, parent.entry.path)
  }
  return { ...directory.entry, aggregatedSizeBytes: directory.bytes }
}

/**
 * Consume a single-root, depth-first stream from traverseDirectory() or
 * traverseDirectoryEvents(). The entry-only API retains its fail-fast behavior.
 * Event streams forward errors and report unknown metadata as errors, allowing
 * partial totals of known bytes. Consumers must retain/handle these errors to
 * distinguish partial results; a finalized directory does not imply completeness.
 * Forward discoveries unchanged, then yield directory-finalized replacements
 * keyed by the same scanId/id. Consumers must update that entry, not insert a
 * second one. No input entry is mutated and no complete snapshot is retained.
 *
 * A change of parent closes completed branches; successful end-of-stream closes
 * the remaining ancestors. Only the active ancestry and one lookahead entry are
 * retained (O(depth)). Errors/early exit never flush unfinished directory totals.
 * Unsafe sums and invalid numeric values remain fatal in both modes.
 */
export function aggregateDirectorySizes(
  entries: AsyncIterable<FileEntry>
): AsyncGenerator<DirectoryAggregationEvent, void, void>
export function aggregateDirectorySizes(
  entries: AsyncIterable<TraversalEvent>
): AsyncGenerator<ScannerAggregationEvent, void, void>
export async function* aggregateDirectorySizes(
  entries: AsyncIterable<FileEntry | TraversalEvent>
): AsyncGenerator<ScannerAggregationEvent, void, void> {
  const stack: DirectoryTotal[] = []

  for await (const item of entries) {
    if (item.type === 'error') {
      yield item
      continue
    }
    const entry = item.type === 'entry' ? item.entry : item
    if (stack.length === 0) {
      if (entry.type !== 'directory' || entry.parentId !== null) {
        throw new Error('Aggregation requires a root directory as the first entry.')
      }
    } else {
      if (entry.scanId !== stack[0].entry.scanId) {
        throw new Error('Aggregation entries must belong to the same scan.')
      }
      if (entry.parentId !== stack[stack.length - 1].entry.id) {
        const parentIndex = stack.findIndex((directory) => directory.entry.id === entry.parentId)
        if (parentIndex < 0) {
          throw new Error(`Entry does not reference an active ancestor directory: ${entry.path}`)
        }
        while (stack.length - 1 > parentIndex) {
          yield { type: 'directory-finalized', entry: finishDirectory(stack) }
        }
      }
    }

    if ((entry.type === 'file' && entry.sizeBytes === null) || entry.type === 'unknown') {
      const message = `Cannot aggregate an unknown size or entry type at ${entry.path}`
      if (item.type !== 'entry') throw new Error(message)
      yield {
        type: 'error',
        error: {
          path: entry.path,
          code: entry.type === 'file' ? 'UNKNOWN_FILE_SIZE' : 'UNKNOWN_ENTRY_TYPE',
          message
        }
      }
    } else if (entry.type === 'directory') {
      stack.push({ entry, bytes: 0 })
    } else if (entry.type === 'file') {
      const parent = stack[stack.length - 1]
      parent.bytes = addBytes(parent.bytes, entry.sizeBytes!, entry.path)
    }

    yield { type: 'entry', entry }
  }

  while (stack.length > 0) {
    yield { type: 'directory-finalized', entry: finishDirectory(stack) }
  }
}
