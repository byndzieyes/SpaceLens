import type { ScanError } from '../../shared/scan'

// Entry-local failures where skipping the affected entry/subtree is meaningful.
// Resource exhaustion and unknown/internal errors deliberately remain fatal.
const recoverableCodes = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'EIO',
  'ESTALE',
  'ELOOP',
  'ENAMETOOLONG',
  'EBUSY',
  'ENODEV',
  'ENXIO',
  'ETIMEDOUT'
])

export class DirectoryChangedError extends Error {
  readonly code = 'ENTRY_CHANGED'

  constructor(path: string) {
    super(`Directory changed before it could be enumerated: ${path}`)
  }
}

/** Call only at filesystem operation boundaries, never around consumer code. */
export function toRecoverableScanError(error: unknown, path: string): ScanError {
  if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError) {
    throw error
  }
  const code = 'code' in error ? error.code : undefined
  if (
    typeof code !== 'string' ||
    (!recoverableCodes.has(code) && !(error instanceof DirectoryChangedError))
  ) {
    throw error
  }
  return { path, code, message: error.message }
}
