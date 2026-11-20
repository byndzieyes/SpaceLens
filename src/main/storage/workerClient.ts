import type { Worker } from 'node:worker_threads'
import type { FileEntry, ScanSession } from '../../shared/scan'
import type { StorageBatchOperation } from './payloads'
import {
  parseStorageResponse,
  type StorageFailure,
  type StorageOperation,
  type StoragePayload,
  type StorageResult
} from './workerProtocol'

export const STORAGE_REQUEST_TIMEOUT_MS = 10_000
export const STORAGE_SHUTDOWN_TIMEOUT_MS = 2_000

interface PendingRequest {
  readonly operation: StorageOperation
  readonly timeout: ReturnType<typeof setTimeout>
  readonly respond: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export class StorageWorkerError extends Error {
  readonly code: string | null
  readonly sqliteCode: number | null

  constructor(failure: StorageFailure) {
    super(failure.message)
    this.name = failure.name
    this.code = failure.code
    this.sqliteCode = failure.sqliteCode
  }
}

/** Owns a worker and at most one in-flight request. Callers must await each operation. */
export class StorageWorkerClient {
  private state: 'idle' | 'initializing' | 'ready' | 'closing' | 'closed' | 'failed' = 'idle'
  private nextId = 1
  private pending: PendingRequest | undefined
  private failure: Error | undefined
  private exited = false
  private closeAcknowledged = false
  private lifecycleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly released = Promise.withResolvers<void>()
  private disposal: Promise<void> | undefined

  constructor(private readonly worker: Worker) {
    worker.on('message', this.onMessage)
    worker.on('messageerror', this.onMessageError)
    worker.on('error', this.onError)
    worker.on('exit', this.onExit)
  }

  async initialize(databasePath: string): Promise<void> {
    if (this.state !== 'idle') {
      throw (
        this.failure ?? new Error(`Cannot initialize the storage worker in state ${this.state}.`)
      )
    }
    this.state = 'initializing'
    await this.send('initialize', { databasePath })
  }

  async insertScan(scan: ScanSession): Promise<void> {
    await this.run('insertScan', scan)
  }

  getScan(id: string): Promise<ScanSession | null> {
    return this.run('getScan', { id })
  }

  async insertEntry(entry: FileEntry): Promise<void> {
    await this.run('insertEntry', entry)
  }

  async applyBatch(scanId: string, operations: readonly StorageBatchOperation[]): Promise<void> {
    await this.run('applyBatch', { scanId, operations })
  }

  getEntry(scanId: string, id: string): Promise<FileEntry | null> {
    return this.run('getEntry', { scanId, id })
  }

  /** Stop accepting work, drain the active request within the grace period, then close. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposal = this.released.promise.then(() => {
      if (this.failure) throw this.failure
    })
    if (this.state === 'failed' || this.state === 'closed') return this.disposal

    this.state = 'closing'
    this.lifecycleTimer = setTimeout(() => {
      this.fail(new Error('Storage worker shutdown timed out.'))
    }, STORAGE_SHUTDOWN_TIMEOUT_MS)
    if (!this.pending) this.sendClose()
    return this.disposal
  }

  private async run<T extends Exclude<StorageOperation, 'initialize' | 'close'>>(
    operation: T,
    payload: StoragePayload<T>
  ): Promise<StorageResult<T>> {
    if (this.state === 'closing' || this.state === 'closed') {
      throw new Error('Storage worker is closing or closed.')
    }
    if (this.state !== 'ready')
      throw this.failure ?? new Error('Storage worker is not initialized.')
    return this.send(operation, payload)
  }

  private send<T extends StorageOperation>(
    operation: T,
    payload: StoragePayload<T>
  ): Promise<StorageResult<T>> {
    if (this.pending) return Promise.reject(new Error('A storage request is already in flight.'))
    const requestId = this.nextId++
    if (!Number.isSafeInteger(requestId)) {
      const error = new Error('Storage worker request IDs are exhausted.')
      this.fail(error)
      return Promise.reject(error)
    }

    const { promise, resolve, reject } = Promise.withResolvers<StorageResult<T>>()
    this.pending = {
      operation,
      reject,
      timeout: setTimeout(() => {
        this.fail(new Error(`Storage worker ${operation} request timed out.`))
      }, STORAGE_REQUEST_TIMEOUT_MS),
      respond: (value) => {
        const response = parseStorageResponse(value, requestId, operation)
        this.clearPending()
        if (!response.ok) {
          const error = new StorageWorkerError(response.error)
          reject(error)
          if (operation === 'initialize' || operation === 'close') this.fail(error)
          return
        }
        if (operation === 'initialize' && this.state === 'initializing') this.state = 'ready'
        if (operation === 'close') this.closeAcknowledged = true
        resolve(response.result)
      }
    }

    try {
      this.worker.postMessage({ requestId, operation, payload })
    } catch (error) {
      this.fail(new Error(`Could not send storage worker ${operation} request.`, { cause: error }))
    }
    return promise
  }

  private sendClose(): void {
    void this.send('close', null).catch(this.fail)
  }

  private clearPending(): PendingRequest | undefined {
    const pending = this.pending
    clearTimeout(pending?.timeout)
    this.pending = undefined
    return pending
  }

  private readonly onMessage = (value: unknown): void => {
    if (this.state === 'failed' || this.state === 'closed') return
    const pending = this.pending
    if (!pending) {
      this.fail(new Error('Storage worker sent a response without a pending request.'))
      return
    }
    try {
      pending.respond(value)
    } catch (error) {
      this.fail(new Error('Storage worker sent an invalid response.', { cause: error }))
      return
    }
    if (this.state === 'closing' && pending.operation !== 'close') this.sendClose()
  }

  private readonly onMessageError = (error: unknown): void => {
    this.fail(new Error('Could not deserialize the storage worker response.', { cause: error }))
  }

  private readonly onError = (error: unknown): void => {
    this.fail(
      error instanceof Error
        ? error
        : new Error('Storage worker threw an uncaught value.', { cause: error })
    )
  }

  private readonly onExit = (code: number): void => {
    this.exited = true
    if (this.state === 'closing' && this.closeAcknowledged && code === 0) this.state = 'closed'
    else this.fail(new Error(`Storage worker exited unexpectedly (code ${code}).`))

    clearTimeout(this.lifecycleTimer)
    this.worker.off('message', this.onMessage)
    this.worker.off('messageerror', this.onMessageError)
    this.worker.off('error', this.onError)
    this.worker.off('exit', this.onExit)
    this.released.resolve()
  }

  private readonly fail = (error: Error): void => {
    if (this.state === 'closed' || this.failure) return
    this.failure = error
    this.state = 'failed'
    this.clearPending()?.reject(error)
    clearTimeout(this.lifecycleTimer)
    if (this.exited) return

    // Native code may delay termination. Keep listeners until exit, but bound the wait
    // and let the process exit even if the worker cannot finish in time.
    this.worker.unref()
    this.lifecycleTimer = setTimeout(() => {
      this.failure = new Error('Storage worker did not exit after forced termination.', {
        cause: error
      })
      this.released.resolve()
    }, STORAGE_SHUTDOWN_TIMEOUT_MS)
    void Promise.resolve()
      .then(() => this.worker.terminate())
      .catch((cause: unknown) => {
        if (this.exited) return
        this.failure = new AggregateError(
          [error, cause],
          'Could not terminate the storage worker.',
          {
            cause
          }
        )
        clearTimeout(this.lifecycleTimer)
        this.released.resolve()
      })
  }
}
