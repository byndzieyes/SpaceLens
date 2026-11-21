import type { ScanPersistence } from '../scanner/persistence'
import type { BuildingScan, CompletedScan, StorageBatchOperation } from './payloads'
import {
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
  | 'getInsightsCategories'
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
}

/** One lane for the initialized Worker. Queued writes precede the bounded FIFO read queue. */
export class ScanStorageCoordinator implements ScanPersistence {
  private client: StorageWorkerClient | undefined
  private failure: StorageUnavailableError | undefined
  private active: Job | undefined
  private write: Job | undefined
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

  read<T>(signal: AbortSignal, query: (client: SnapshotQueries) => Promise<T>): Promise<T> {
    return this.enqueue(query, signal)
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
    for (const job of this.reads.splice(0)) job.reject(error)
    if (this.active?.read) this.active.reject(error)
  }

  private enqueue<T>(
    operation: (client: StorageWorkerClient) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.client && !this.client.isReady) this.fail()
    if (this.failure) return Promise.reject(this.failure)
    const read = signal !== undefined
    if (read && (signal.aborted || this.readsStopped)) {
      return Promise.reject(new StorageUnavailableError('The storage request is no longer active.'))
    }
    if (read ? this.reads.length >= MAX_QUEUED_EXPLORER_READS : this.write !== undefined) {
      return Promise.reject(
        new StorageUnavailableError('Saved scan storage is busy. Retry the request.')
      )
    }

    const { promise, resolve, reject } = Promise.withResolvers<T>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearReadHandlers = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const cancelRead = (message: string): void => {
      const index = this.reads.indexOf(job)
      if (index >= 0) this.reads.splice(index, 1)
      job.reject(new StorageUnavailableError(message))
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
        }
      },
      reject: (error) => {
        clearReadHandlers()
        reject(error)
      }
    }
    if (signal) {
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => cancelRead('Waiting for saved scan storage timed out. Retry the request.'),
        STORAGE_REQUEST_TIMEOUT_MS
      )
      this.reads.push(job)
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
    const job = this.write ?? this.reads.shift()
    if (!job) return
    if (job === this.write) this.write = undefined
    this.active = job
    void job.run(this.client).then(() => {
      this.active = undefined
      this.drain()
    })
  }

  private fail(): void {
    this.failure ??= new StorageUnavailableError()
    for (const job of this.reads.splice(0)) job.reject(this.failure)
    this.write?.reject(this.failure)
    this.write = undefined
  }
}
