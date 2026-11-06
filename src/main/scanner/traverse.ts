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

async function checkDirectory(path: string, expected: Stats): Promise<void> {
  const current = await lstat(path)
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new DirectoryChangedError(path)
  }
}

async function openDirectory(path: string, expected: Stats): Promise<Dir> {
  // Check again after consumer yields and after opening, before reading children.
  // Path-based checks reduce replacement races; they are not an atomic snapshot.
  await checkDirectory(path, expected)
  const directory = await opendir(path)
  try {
    await checkDirectory(path, expected)
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
  scanId: string
): AsyncGenerator<TraversalEvent, void, void> {
  if (rootPath.length === 0) throw new TypeError('Root path must not be empty.')
  if (scanId.trim().length === 0) throw new TypeError('Scan ID must not be empty.')

  const path = resolve(rootPath)
  const stats = await lstat(path)
  if (!stats.isDirectory()) throw new Error('Scan root must be a directory, not a file or symlink.')

  const root = createFileEntry(path, scanId, null, stats)
  const stack: DirectoryFrame[] = []
  let failure: unknown

  try {
    stack.push({ directory: await openDirectory(path, stats), entry: root, stats })
    yield { type: 'entry', entry: root }

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      let child: Dirent | null
      try {
        // A consumer yield or a previous read may have allowed this path to change.
        await checkDirectory(frame.entry.path, frame.stats)
        child = await frame.directory.read()
      } catch (error) {
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
        childStats = await lstat(childPath)
      } catch (error) {
        yield { type: 'error', error: toRecoverableScanError(error, childPath) }
        continue
      }
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
      yield { type: 'entry', entry }

      if (entry.type === 'directory') {
        let directory: Dir
        try {
          directory = await openDirectory(childPath, childStats)
        } catch (error) {
          yield { type: 'error', error: toRecoverableScanError(error, childPath) }
          continue
        }
        stack.push({ directory, entry, stats: childStats })
      }
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Attempt every close, including when traversal fails or the consumer stops.
    await closeDirectories(stack, failure)
  }
}
