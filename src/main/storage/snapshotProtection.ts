import { readSnapshotId, SnapshotAccessError } from './snapshotAccess'

const MAX_OWNERS = 8
const MAX_SNAPSHOTS_PER_OWNER = 2

export interface SnapshotProtectionOwner<T> {
  acquire(scanId: string, attempt?: AbortSignal): Promise<T>
  release(scanId: string): void
  dispose(): void
}

/** Main-owned reservations shared by view leases, admitted reads, and deletion. */
export class SnapshotProtection {
  private readonly leases = new Map<string, number>()
  private owners = 0
  private deleting: string | undefined

  constructor(private readonly onReleased: (scanId: string) => void = () => {}) {}

  isProtected(scanId: string): boolean {
    return this.leases.has(scanId)
  }

  protectedScanIds(): string[] {
    return [...this.leases.keys()]
  }

  get deletionPending(): boolean {
    return this.deleting !== undefined
  }

  reserve(scanId: string): () => void {
    readSnapshotId({ scanId })
    if (this.deleting === scanId)
      throw new SnapshotAccessError('SNAPSHOT_IN_USE', 'This snapshot is being deleted.')
    this.leases.set(scanId, (this.leases.get(scanId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.leases.get(scanId)!
      if (count === 1) {
        this.leases.delete(scanId)
        this.onReleased(scanId)
      } else this.leases.set(scanId, count - 1)
    }
  }

  reservePair(baselineScanId: string, targetScanId: string): () => void {
    const releaseBaseline = this.reserve(baselineScanId)
    try {
      const releaseTarget = this.reserve(targetScanId)
      return () => {
        releaseBaseline()
        releaseTarget()
      }
    } catch (error) {
      releaseBaseline()
      throw error
    }
  }

  createPairOwner(signal: AbortSignal, baselineScanId: string, targetScanId: string): () => void {
    const releaseOwner = this.claimOwner(signal)
    try {
      const releasePair = this.reservePair(baselineScanId, targetScanId)
      const dispose = (): void => {
        signal.removeEventListener('abort', dispose)
        releaseOwner()
        releasePair()
      }
      signal.addEventListener('abort', dispose, { once: true })
      return dispose
    } catch (error) {
      releaseOwner()
      throw error
    }
  }

  assertDeletable(scanId: string): void {
    if (this.isProtected(scanId) || this.deleting === scanId)
      throw new SnapshotAccessError('SNAPSHOT_IN_USE', 'This snapshot is in use.')
  }

  admitDeletion(scanId: string): () => void {
    this.assertDeletable(scanId)
    if (this.deletionPending) throw new Error('A snapshot deletion is already pending.')
    this.deleting = scanId
    let released = false
    return () => {
      if (released) return
      released = true
      this.deleting = undefined
    }
  }

  createOwner<T>(
    signal: AbortSignal,
    validate: (scanId: string, signal: AbortSignal) => Promise<T>
  ): SnapshotProtectionOwner<T> {
    const releaseOwner = this.claimOwner(signal)
    const owned = new Map<string, { release: () => void; ready: Promise<T> }>()
    let disposed = false
    const inactive = (): SnapshotAccessError =>
      new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'The snapshot owner is no longer active.')
    const release = (scanId: string): void => {
      owned.get(scanId)?.release()
      owned.delete(scanId)
    }
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      signal.removeEventListener('abort', dispose)
      for (const scanId of owned.keys()) release(scanId)
      releaseOwner()
    }
    signal.addEventListener('abort', dispose, { once: true })
    return {
      acquire: async (scanId, attempt) => {
        if (disposed || attempt?.aborted) throw inactive()
        const existing = owned.get(scanId)
        if (existing) return existing.ready
        if (owned.size >= MAX_SNAPSHOTS_PER_OWNER)
          throw new SnapshotAccessError(
            'SNAPSHOT_UNAVAILABLE',
            'The snapshot owner is at capacity.'
          )
        const releaseLease = this.reserve(scanId)
        const current = (): boolean => owned.get(scanId)?.release === releaseLease
        const ready = Promise.resolve()
          .then(async () => {
            if (!current() || attempt?.aborted) throw inactive()
            const metadata = await validate(
              scanId,
              attempt ? AbortSignal.any([signal, attempt]) : signal
            )
            if (!current() || attempt?.aborted) throw inactive()
            return metadata
          })
          .catch((error: unknown) => {
            if (current()) release(scanId)
            throw error
          })
        owned.set(scanId, { release: releaseLease, ready })
        return ready
      },
      release,
      dispose
    }
  }

  private claimOwner(signal: AbortSignal): () => void {
    if (signal.aborted || this.owners >= MAX_OWNERS)
      throw new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'Snapshot protection is unavailable.')
    this.owners++
    let released = false
    return () => {
      if (released) return
      released = true
      this.owners--
    }
  }
}
