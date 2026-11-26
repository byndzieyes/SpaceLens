import type { ScanPersistence } from '../scanner/persistence'
import type { ScanHistoryItem, SnapshotDeletionRequest } from '../../shared/history'
import type {
  BuildingScan,
  CompletedScan,
  CommittedSnapshotDeletion,
  RetentionCandidate,
  StorageBatchOperation
} from './payloads'
import { readSnapshotId, SnapshotAccessError } from './snapshotAccess'
import { SnapshotProtection, type SnapshotProtectionOwner } from './snapshotProtection'
import {
  isUncertainStorageWrite,
  STORAGE_REQUEST_TIMEOUT_MS,
  StorageWorkerError,
  type StorageWorkerClient
} from './workerClient'

export const MAX_QUEUED_EXPLORER_READS = 16

export type RetentionOpportunity =
  | { readonly type: 'idle' | 'publication' | 'manual-deletion' }
  | { readonly type: 'released'; readonly scanId: string }

type SnapshotQueries = Pick<
  StorageWorkerClient,
  | 'getScanSnapshot'
  | 'openSavedSnapshot'
  | 'getScanEntry'
  | 'listScanDirectory'
  | 'getScanDirectoryTreemap'
  | 'requireValidatedScan'
  | 'listScanHistory'
  | 'getScanHistoryMetadata'
  | 'listComparisonMatches'
  | 'getInsightsCategories'
  | 'getInsightsSizeDistribution'
  | 'getInsightsObservations'
  | 'listInsightsExtensions'
  | 'listInsightsLargestFiles'
  | 'listInsightsLargestDirectories'
>

/** A request that could not be sent, or a read whose reply can no longer be used. */
export class StorageUnavailableError extends StorageWorkerError {
  constructor(message = 'Saved scan storage is unavailable.') {
    super({ name: 'StorageUnavailableError', message, code: null, sqliteCode: null })
  }
}

interface Job {
  readonly read: boolean
  readonly run: (client: StorageWorkerClient) => Promise<void>
  readonly reject: (error: StorageUnavailableError) => void
  readonly drop: (error: StorageUnavailableError) => void
}

/** One lane for the initialized Worker. Queued writes precede the bounded FIFO read queue. */
export class ScanStorageCoordinator implements ScanPersistence {
  private client: StorageWorkerClient | undefined
  private failure: StorageUnavailableError | undefined
  private active: Job | undefined
  private write: Job | undefined
  private deletion: Job | undefined
  private readonly protection = new SnapshotProtection((scanId) =>
    this.signalRetention({ type: 'released', scanId })
  )
  private retentionListener: ((opportunity: RetentionOpportunity) => void) | undefined
  private buildingScanId: string | undefined
  private readonly reads: Job[] = []
  private readsStopped = false

  constructor(ready: Promise<StorageWorkerClient>) {
    void ready.then(
      (client) => {
        this.client = client
        this.drain()
      },
      () => this.fail()
    )
  }

  read<T>(
    signal: AbortSignal,
    query: (client: SnapshotQueries) => Promise<T>,
    scanId?: string
  ): Promise<T> {
    return this.enqueue(query, signal, scanId)
  }

  createSnapshotOwner(signal: AbortSignal): SnapshotProtectionOwner<ScanHistoryItem> {
    return this.protection.createOwner(signal, (scanId, validationSignal) =>
      this.read(
        validationSignal,
        async (client) => {
          const metadata = await client.getScanHistoryMetadata({ scanId })
          if (metadata.id !== scanId) throw new Error('Storage returned a different history scan.')
          return metadata
        },
        scanId
      )
    )
  }

  isSnapshotProtected(scanId: string): boolean {
    return this.protection.isProtected(scanId)
  }

  get retentionIdle(): boolean {
    return (
      !!this.client?.isReady &&
      !this.failure &&
      !this.readsStopped &&
      !this.active &&
      !this.write &&
      !this.protection.deletionPending &&
      !this.reads.length &&
      this.buildingScanId === undefined
    )
  }

  observeRetention(listener: (opportunity: RetentionOpportunity) => void): () => void {
    if (this.retentionListener) throw new Error('Retention is already observing storage.')
    this.retentionListener = listener
    return () => {
      if (this.retentionListener === listener) this.retentionListener = undefined
    }
  }

  async findRetentionCandidate(
    limit: number,
    signal: AbortSignal
  ): Promise<(RetentionCandidate & { protectedScanIds: readonly string[] }) | undefined> {
    if (!this.retentionIdle) return undefined
    const protectedScanIds = this.protection.protectedScanIds()
    const result = await this.enqueue(
      (client) => client.getRetentionCandidate({ limit, protectedScanIds }),
      signal
    )
    return { ...result, protectedScanIds }
  }

  async pruneSnapshotIfIdle(
    scanId: string,
    limit: number
  ): Promise<CommittedSnapshotDeletion | null | undefined> {
    if (!this.retentionIdle) return undefined
    return this.delete(scanId, (client) =>
      client.pruneSnapshot({ scanId, limit, protectedScanIds: this.protection.protectedScanIds() })
    )
  }

  async deleteSnapshot(request: SnapshotDeletionRequest): Promise<CommittedSnapshotDeletion> {
    const scanId = readSnapshotId(request)
    const result = await this.delete(scanId, (client) => client.deleteSnapshot({ scanId }))
    this.signalRetention({ type: 'manual-deletion' })
    return result
  }

  private async delete<T extends CommittedSnapshotDeletion | null>(
    scanId: string,
    operation: (client: StorageWorkerClient) => Promise<T>
  ): Promise<T> {
    if (this.failure) throw this.failure
    if (this.readsStopped) throw new StorageUnavailableError('Saved scan storage is shutting down.')
    if (this.protection.deletionPending) {
      // The authoritative reservation rejects duplicates even while the worker is busy.
      this.protection.assertDeletable(scanId)
      throw new StorageUnavailableError('A snapshot deletion is already pending.')
    }
    const release = this.protection.admitDeletion(scanId)
    let uncertain = false
    try {
      return await this.enqueue(
        async (client) => {
          try {
            return await operation(client)
          } catch (error) {
            if (!isUncertainStorageWrite(error)) throw error
            uncertain = true
            this.fail()
            throw new SnapshotAccessError(
              'SNAPSHOT_DELETE_UNCERTAIN',
              'Storage could not confirm the deletion. Restart SpaceLens to recover the saved state.'
            )
          }
        },
        undefined,
        undefined,
        true
      )
    } finally {
      if (!uncertain) {
        release()
        this.notifyIdle()
      }
    }
  }

  beginScan(scan: BuildingScan): Promise<void> {
    return this.enqueue(async (client) => {
      await client.beginScan(scan)
      this.buildingScanId = scan.id
    })
  }

  applyBatch(scanId: string, operations: readonly StorageBatchOperation[]): Promise<void> {
    return this.enqueue((client) => client.applyBatch(scanId, operations))
  }

  publishScan(scan: CompletedScan, rootEntryId: string): Promise<CompletedScan> {
    return this.enqueue(async (client) => {
      const published = await client.publishScan(scan, rootEntryId)
      if (this.buildingScanId === scan.id) this.buildingScanId = undefined
      this.signalRetention({ type: 'publication' })
      return published
    })
  }

  discardBuildingScan(scanId: string): Promise<void> {
    return this.enqueue(async (client) => {
      await client.discardBuildingScan(scanId)
      if (this.buildingScanId === scanId) this.buildingScanId = undefined
    })
  }

  /** Drop read requests before scanner shutdown, which may still need a final write. */
  stopReads(): void {
    this.readsStopped = true
    const error = new StorageUnavailableError('Saved scan storage is shutting down.')
    for (const job of this.reads.splice(0)) job.drop(error)
    if (this.active?.read) this.active.reject(error)
  }

  private enqueue<T>(
    operation: (client: StorageWorkerClient) => Promise<T>,
    signal?: AbortSignal,
    scanId?: string,
    deletion = false
  ): Promise<T> {
    if (this.client && !this.client.isReady) this.fail()
    if (this.failure) return Promise.reject(this.failure)
    const read = signal !== undefined
    if (read && (signal.aborted || this.readsStopped)) {
      return Promise.reject(new StorageUnavailableError('The storage request is no longer active.'))
    }
    if (
      read ? this.reads.length >= MAX_QUEUED_EXPLORER_READS : !deletion && this.write !== undefined
    ) {
      return Promise.reject(
        new StorageUnavailableError('Saved scan storage is busy. Retry the request.')
      )
    }

    let release: (() => void) | undefined
    try {
      if (scanId !== undefined) release = this.protection.reserve(scanId)
    } catch (error) {
      return Promise.reject(error)
    }
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearReadHandlers = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const cancelRead = (message: string): void => {
      const index = this.reads.indexOf(job)
      const error = new StorageUnavailableError(message)
      if (index < 0) job.reject(error)
      else {
        this.reads.splice(index, 1)
        job.drop(error)
      }
    }
    const abort = (): void => cancelRead('The storage request is no longer active.')
    const job: Job = {
      read,
      run: async (client) => {
        clearTimeout(timer)
        try {
          resolve(await operation(client))
        } catch (error) {
          // Preserve the original error for a dispatched write whose outcome may be unknown.
          reject(read && !client.isReady ? new StorageUnavailableError() : error)
        } finally {
          clearReadHandlers()
          if (release && !client.isReady) await client.waitForExit()
          release?.()
        }
      },
      reject: (error) => {
        clearReadHandlers()
        reject(error)
      },
      drop: (error) => {
        job.reject(error)
        release?.()
      }
    }
    if (signal) {
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => cancelRead('Waiting for saved scan storage timed out. Retry the request.'),
        STORAGE_REQUEST_TIMEOUT_MS
      )
      this.reads.push(job)
    } else if (deletion) {
      this.deletion = job
    } else {
      this.write = job
    }
    this.drain()
    return promise
  }

  private drain(): void {
    if (this.active || !this.client || this.failure) return
    if (!this.client.isReady) {
      this.fail()
      return
    }
    const job = this.write ?? this.deletion ?? this.reads.shift()
    if (!job) {
      this.notifyIdle()
      return
    }
    if (job === this.write) this.write = undefined
    if (job === this.deletion) this.deletion = undefined
    this.active = job
    void job.run(this.client).then(() => {
      this.active = undefined
      this.drain()
    })
  }

  private notifyIdle(): void {
    if (this.retentionIdle) this.signalRetention({ type: 'idle' })
  }

  private signalRetention(event: RetentionOpportunity): void {
    try {
      this.retentionListener?.(event)
    } catch (error) {
      console.error('Could not schedule history retention.', error)
    }
  }

  private fail(): void {
    this.failure ??= new StorageUnavailableError()
    for (const job of this.reads.splice(0)) job.drop(this.failure)
    this.write?.reject(this.failure)
    this.write = undefined
    this.deletion?.reject(this.failure)
    this.deletion = undefined
  }
}
