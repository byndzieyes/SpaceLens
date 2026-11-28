import { win32 } from 'node:path'
import type { ComparisonPathKey, ComparisonPathStyle } from '../../shared/comparison'
import type { FileEntry } from '../../shared/scan'

function validComponent(component: string, style: ComparisonPathStyle): boolean {
  if (!component || component === '.' || component === '..') return false
  return (
    style === 'posix' ||
    (!/[\\<>:"|?*]/.test(component) &&
      !/[. ]$/.test(component) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component) &&
      // eslint-disable-next-line no-control-regex -- Windows rejects these ASCII code units in names.
      !/[\u0000-\u001f]/.test(component))
  )
}

export function normalizeComparisonRoot(path: string, style: ComparisonPathStyle): string | null {
  if (path.includes('\0')) return null
  const text = style === 'win32' ? path.replaceAll('\\', '/') : path
  let volumeLength: number
  let prefix: string
  if (style === 'posix') {
    // The scanner resolves POSIX roots to a single leading slash.
    if (!text.startsWith('/') || text.startsWith('//')) return null
    volumeLength = 1
    prefix = '/'
  } else if (/^[a-z]:\//i.test(text)) {
    volumeLength = 3
    prefix = text.slice(0, volumeLength).toLowerCase()
  } else {
    const volume = win32.parse(text).root
    const share = /^\/\/([^/]+)\/([^/]+)\/?$/.exec(volume)
    if (!share || !share.slice(1).every((part) => validComponent(part, style))) return null
    volumeLength = volume.length
    prefix = `//${share[1]}/${share[2]}/`
  }

  const components = text.slice(volumeLength).replace(/\/+$/, '')
  if (components && !components.split('/').every((part) => validComponent(part, style))) return null
  return prefix + components
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
  const drive = style === 'win32' && /^[a-z]:\//.test(prefix)
  const driveCode = prefix.charCodeAt(0)
  const driveRelativePrefix = drive ? prefix.slice(1) : ''
  return (entry) => {
    if (entry.parentId === null)
      return entry.type === 'directory' && normalizeComparisonRoot(entry.path, style) === root
        ? ''
        : null

    // The root prefix is already canonical and validated. Only the relative components vary.
    const path = style === 'win32' ? entry.path.replaceAll('\\', '/') : entry.path
    const underRoot = drive
      ? (path.charCodeAt(0) | 32) === driveCode && path.startsWith(driveRelativePrefix, 1)
      : path.startsWith(prefix)
    if (!underRoot || path.length === prefix.length) return null
    const key = path.slice(prefix.length)
    return isComparisonPathKey(key, style) ? key : null
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
