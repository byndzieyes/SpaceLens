import { lstat, opendir, realpath } from 'node:fs/promises'

/** Main-only identity of the canonical directory explicitly selected by the user. */
export interface DirectoryApproval {
  readonly path: string
  readonly dev: bigint
  readonly ino: bigint
}

/** Resolve selected links/junctions to their target and verify directory access. */
export async function inspectScanDirectory(path: string): Promise<DirectoryApproval> {
  const canonical = await realpath(path)
  const before = await lstat(canonical, { bigint: true })
  if (!before.isDirectory()) throw new Error('Selection is not a directory.')
  const handle = await opendir(canonical)
  await handle.close()
  const after = await lstat(canonical, { bigint: true })
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error('Selected directory changed during validation.')
  }
  return { path: canonical, dev: after.dev, ino: after.ino }
}

/** Path checks are not an atomic filesystem snapshot; the scanner also checks changes. */
export async function verifyScanDirectory(approval: DirectoryApproval): Promise<boolean> {
  const current = await inspectScanDirectory(approval.path)
  return (
    current.path === approval.path && current.dev === approval.dev && current.ino === approval.ino
  )
}
