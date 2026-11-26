import { posix, win32 } from 'node:path'
import type { ComparisonPathKey, ComparisonPathStyle } from '../../shared/comparison'
import type { FileEntry } from '../../shared/scan'

function validComponent(component: string, style: ComparisonPathStyle): boolean {
  if (!component || component === '.' || component === '..') return false
  return (
    style === 'posix' ||
    (!/[\\<>:"|?*]/.test(component) &&
      !/[. ]$/.test(component) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component) &&
      ![...component].some((character) => character.charCodeAt(0) < 32))
  )
}

function absolutePath(
  path: string,
  style: ComparisonPathStyle,
  allowTrailingSeparator: boolean
): string | null {
  if (path.includes('\0')) return null
  const text = style === 'win32' ? path.replaceAll('\\', '/') : path
  const volume = (style === 'win32' ? win32 : posix).parse(text).root
  let prefix: string
  if (style === 'posix') {
    // The scanner resolves POSIX roots to a single leading slash.
    if (volume !== '/' || text.startsWith('//')) return null
    prefix = volume
  } else if (/^[a-z]:\/$/i.test(volume)) {
    prefix = volume.toLowerCase()
  } else {
    const share = /^\/\/([^/]+)\/([^/]+)\/?$/.exec(volume)
    if (!share || !share.slice(1).every((part) => validComponent(part, style))) return null
    prefix = `//${share[1]}/${share[2]}/`
  }

  const suffix = text.slice(volume.length)
  const components = allowTrailingSeparator ? suffix.replace(/\/+$/, '') : suffix
  if (components && !components.split('/').every((part) => validComponent(part, style))) return null
  return prefix + components
}

/** Lexical only. Never make a historical path relative to the current working directory. */
export function normalizeComparisonRoot(
  rootPath: string,
  style: ComparisonPathStyle
): string | null {
  return absolutePath(rootPath, style, true)
}

/** Validate containment and root identity before deriving the case-sensitive matching key. */
export function comparisonPathKey(
  rootPath: string,
  entry: Pick<FileEntry, 'path' | 'parentId' | 'type'>,
  style: ComparisonPathStyle
): ComparisonPathKey | null {
  return createComparisonPathKey(rootPath, style)?.(entry) ?? null
}

/** Normalize the root once for callers deriving several keys from the same snapshot. */
export function createComparisonPathKey(
  rootPath: string,
  style: ComparisonPathStyle
): ((entry: Pick<FileEntry, 'path' | 'parentId' | 'type'>) => ComparisonPathKey | null) | null {
  const root = normalizeComparisonRoot(rootPath, style)
  if (root === null) return null
  const prefix = root.endsWith('/') ? root : root + '/'
  return (entry) => {
    const isRoot = entry.parentId === null
    const path = absolutePath(entry.path, style, isRoot)
    if (path === null) return null
    if (isRoot) return path === root && entry.type === 'directory' ? '' : null
    return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null
  }
}

export function isComparisonPathKey(key: string, style: ComparisonPathStyle): boolean {
  return (
    key === '' ||
    (!key.includes('\0') && key.split('/').every((part) => validComponent(part, style)))
  )
}

/** Find an ambiguous key in one snapshot's sorted stream, without collecting the tree. */
export function findComparisonPathCollision(
  sortedKeys: Iterable<ComparisonPathKey>
): ComparisonPathKey | null {
  let previous: ComparisonPathKey | undefined
  for (const key of sortedKeys) {
    if (key === previous) return key
    previous = key
  }
  return null
}
