import type { FileEntry } from '../../shared/scan'

export type DirectoryAggregationEvent =
  | { readonly type: 'entry'; readonly entry: FileEntry }
  | { readonly type: 'directory-finalized'; readonly entry: FileEntry }

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
 * Consume the single-root, depth-first entry stream from traverseDirectory().
 * Forward discoveries unchanged, then yield directory-finalized replacements
 * keyed by the same scanId/id. Consumers must update that entry, not insert a
 * second one. No input entry is mutated and no complete snapshot is retained.
 *
 * A change of parent closes completed branches; successful end-of-stream closes
 * the remaining ancestors. Only the active ancestry and one lookahead entry are
 * retained (O(depth)). Errors/early exit never flush unfinished directory totals.
 * Unknown sizes/types and unsafe sums fail rather than claim a verified total.
 */
export async function* aggregateDirectorySizes(
  entries: AsyncIterable<FileEntry>
): AsyncGenerator<DirectoryAggregationEvent, void, void> {
  const stack: DirectoryTotal[] = []

  for await (const entry of entries) {
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

    if (entry.type === 'directory') {
      stack.push({ entry, bytes: 0 })
    } else if (entry.type === 'file') {
      if (entry.sizeBytes === null) {
        throw new Error(`Cannot aggregate an unknown logical file size at ${entry.path}`)
      }
      const parent = stack[stack.length - 1]
      parent.bytes = addBytes(parent.bytes, entry.sizeBytes, entry.path)
    } else if (entry.type === 'unknown') {
      throw new Error(`Cannot aggregate an unclassified entry at ${entry.path}`)
    }

    yield { type: 'entry', entry }
  }

  while (stack.length > 0) {
    yield { type: 'directory-finalized', entry: finishDirectory(stack) }
  }
}
