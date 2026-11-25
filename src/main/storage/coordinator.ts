import type { ScanPersistence } from '../scanner/persistence'
import type { SnapshotDeletionRequest } from '../../shared/history'
import type {
  BuildingScan,
  CompletedScan,
  CommittedSnapshotDeletion,
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

type SnapshotQueries = Pick<
  StorageWorkerClient,
  | 'getScanSnapshot'
  | 'getScanEntry'
  | 'listScanDirectory'
  | 'getScanDirectoryTreemap'
  | 'requirePublishedScan'
  | 'listScanHistory'
  | 'getScanHistoryMetadata'
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
  private readonly protection = new SnapshotProtection()
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

  createSnapshotOwner(signal: AbortSignal): SnapshotProtectionOwner {
    return this.protection.createOwner(signal, (scanId) =>
      this.read(signal, (client) => client.getScanHistoryMetadata({ scanId }), scanId)
    )
  }

  isSnapshotProtected(scanId: string): boolean {
    return this.protection.isProtected(scanId)
  }

  async deleteSnapshot(request: SnapshotDeletionRequest): Promise<CommittedSnapshotDeletion> {
    const scanId = readSnapshotId(request)
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
            return await client.deleteSnapshot({ scanId })
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
      if (!uncertain) release()
    }
  }

  beginScan(scan: BuildingScan): Promise<void> {
    return this.enqueue((client) => client.beginScan(scan))
  }

  applyBatch(scanId: string, operations: readonly StorageBatchOperation[]): Promise<void> {
    return this.enqueue((client) => client.applyBatch(scanId, operations))
  }

  publishScan(scan: CompletedScan, rootEntryId: string): Promise<CompletedScan> {
    return this.enqueue((client) => client.publishScan(scan, rootEntryId))
  }

  discardBuildingScan(scanId: string): Promise<void> {
    return this.enqueue((client) => client.discardBuildingScan(scanId))
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
    if (!job) return
    if (job === this.write) this.write = undefined
    if (job === this.deletion) this.deletion = undefined
    this.active = job
    void job.run(this.client).then(() => {
      this.active = undefined
      this.drain()
    })
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
