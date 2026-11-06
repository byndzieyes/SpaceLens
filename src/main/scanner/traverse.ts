import type { Dir } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FileEntry } from '../../shared/scan'
import { createFileEntry } from './fileEntry'

interface DirectoryFrame {
  readonly directory: Dir
  readonly entry: FileEntry
}

async function closeDirectories(stack: DirectoryFrame[]): Promise<void> {
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
    throw new AggregateError(errors, 'Failed to close traversal directory handles.')
  }
}

/**
 * Read-only, sequential depth-first traversal. Parents precede children; sibling
 * order is filesystem-dependent. Symlinks (including a symlink root) are not followed.
 * Keeps one directory handle per active depth, not an array of all entries.
 * Filesystem errors propagate to the consumer; metadata outside the supported
 * numeric/date range is emitted as null. Consumers should use for-await or call
 * return() when stopping early so open directory handles are released.
 */
export async function* traverseDirectory(
  rootPath: string,
  scanId: string
): AsyncGenerator<FileEntry, void, void> {
  if (rootPath.length === 0) throw new TypeError('Root path must not be empty.')
  if (scanId.trim().length === 0) throw new TypeError('Scan ID must not be empty.')

  const path = resolve(rootPath)
  const stats = await lstat(path)
  if (!stats.isDirectory()) throw new Error('Scan root must be a directory, not a file or symlink.')

  const root = createFileEntry(path, scanId, null, stats)
  const stack: DirectoryFrame[] = []

  try {
    yield root
    stack.push({ directory: await opendir(path), entry: root })

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const child = await frame.directory.read()
      if (child === null) {
        stack.pop()
        await frame.directory.close()
        continue
      }

      const childPath = join(frame.entry.path, child.name)
      const entry = createFileEntry(childPath, scanId, frame.entry.id, await lstat(childPath))
      yield entry

      if (entry.type === 'directory') {
        stack.push({ directory: await opendir(childPath), entry })
      }
    }
  } finally {
    // Attempt every close, including when traversal fails or the consumer stops.
    await closeDirectories(stack)
  }
}
