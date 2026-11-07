import type { Dir, Dirent, Stats } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FileEntry, ScanError } from '../../shared/scan'
import { createFileEntry, getEntryType } from './fileEntry'
import { DirectoryChangedError, toRecoverableScanError } from './errors'

export type TraversalEvent =
  | { readonly type: 'entry'; readonly entry: FileEntry }
  | { readonly type: 'error'; readonly error: ScanError }

interface DirectoryFrame {
  readonly directory: Dir
  readonly entry: FileEntry
  readonly stats: Stats
}

async function closeDirectories(stack: DirectoryFrame[], failure?: unknown): Promise<void> {
  const errors: unknown[] = []
  while (stack.length > 0) {
    const frame = stack.pop()!
    try {
      await frame.directory.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      failure === undefined ? errors : [failure, ...errors],
      'Failed to close traversal directory handles.'
    )
  }
}

async function checkDirectory(path: string, expected: Stats, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const current = await lstat(path)
  signal?.throwIfAborted()
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new DirectoryChangedError(path)
  }
}

async function openDirectory(path: string, expected: Stats, signal?: AbortSignal): Promise<Dir> {
  // Check again after consumer yields and after opening, before reading children.
  // Path-based checks reduce replacement races; they are not an atomic snapshot.
  await checkDirectory(path, expected, signal)
  signal?.throwIfAborted()
  const directory = await opendir(path)
  try {
    await checkDirectory(path, expected, signal)
    return directory
  } catch (error) {
    try {
      await directory.close()
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Failed to close a changed directory.', {
        cause: closeError
      })
    }
    throw error
  }
}

/**
 * Compatibility iterator: discoveries only, failing on the first reported error.
 * Use traverseDirectoryEvents() for incremental, recoverable error handling.
 */
export async function* traverseDirectory(
  rootPath: string,
  scanId: string
): AsyncGenerator<FileEntry, void, void> {
  for await (const event of traverseDirectoryEvents(rootPath, scanId)) {
    if (event.type === 'error') {
      throw Object.assign(new Error(event.error.message), {
        code: event.error.code,
        path: event.error.path
      })
    }
    yield event.entry
  }
}

/**
 * Sequential, read-only depth-first traversal, retaining O(depth) open handles.
 * Root access/enumeration failures are fatal. Expected child access failures
 * produce plain error data and skip that entry or the unread remainder of its
 * directory. Metadata failures do not invent an entry or a zero-byte size.
 * Symlinks are never intentionally followed; sibling order is unspecified.
 * Use for-await or return() on early exit to release directory handles.
 */
export async function* traverseDirectoryEvents(
  rootPath: string,
  scanId: string,
  signal?: AbortSignal
): AsyncGenerator<TraversalEvent, void, void> {
  signal?.throwIfAborted()
  if (rootPath.length === 0) throw new TypeError('Root path must not be empty.')
  if (scanId.trim().length === 0) throw new TypeError('Scan ID must not be empty.')

  const path = resolve(rootPath)
  const stats = await lstat(path)
  signal?.throwIfAborted()
  if (!stats.isDirectory()) throw new Error('Scan root must be a directory, not a file or symlink.')

  const root = createFileEntry(path, scanId, null, stats)
  const stack: DirectoryFrame[] = []
  let failure: unknown

  try {
    stack.push({ directory: await openDirectory(path, stats, signal), entry: root, stats })
    signal?.throwIfAborted()
    yield { type: 'entry', entry: root }

    while (stack.length > 0) {
      signal?.throwIfAborted()
      const frame = stack[stack.length - 1]
      let child: Dirent | null
      try {
        // A consumer yield or a previous read may have allowed this path to change.
        await checkDirectory(frame.entry.path, frame.stats, signal)
        signal?.throwIfAborted()
        child = await frame.directory.read()
        signal?.throwIfAborted()
      } catch (error) {
        signal?.throwIfAborted()
        if (frame.entry.parentId === null) throw error
        const reported = toRecoverableScanError(error, frame.entry.path)
        stack.pop()
        try {
          await frame.directory.close()
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'Failed to close an unreadable directory.',
            {
              cause: closeError
            }
          )
        }
        yield { type: 'error', error: reported }
        continue
      }
      if (child === null) {
        stack.pop()
        await frame.directory.close()
        continue
      }

      const childPath = join(frame.entry.path, child.name)
      let childStats: Stats
      try {
        signal?.throwIfAborted()
        childStats = await lstat(childPath)
      } catch (error) {
        signal?.throwIfAborted()
        yield { type: 'error', error: toRecoverableScanError(error, childPath) }
        continue
      }
      signal?.throwIfAborted()
      const entry = createFileEntry(childPath, scanId, frame.entry.id, childStats)
      if (getEntryType(child) !== entry.type) {
        yield {
          type: 'error',
          error: {
            path: childPath,
            code: 'ENTRY_TYPE_CHANGED',
            message: `Entry changed from ${getEntryType(child)} to ${entry.type} during traversal.`
          }
        }
      }
      signal?.throwIfAborted()
      yield { type: 'entry', entry }

      if (entry.type === 'directory') {
        let directory: Dir
        try {
          directory = await openDirectory(childPath, childStats, signal)
        } catch (error) {
          signal?.throwIfAborted()
          yield { type: 'error', error: toRecoverableScanError(error, childPath) }
          continue
        }
        stack.push({ directory, entry, stats: childStats })
      }
    }
    signal?.throwIfAborted()
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Attempt every close, including when traversal fails or the consumer stops.
    await closeDirectories(stack, failure)
  }
}
