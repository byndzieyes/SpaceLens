import { randomUUID } from 'node:crypto'
import type { ScanPersistence } from '../scanner/persistence'
import type { ScanHistoryItem, SnapshotDeletionRequest } from '../../shared/history'
import type { ComparisonPair } from '../../shared/comparison'
import type {
  ComparisonPreparationRequest,
  ComparisonPreparationStatus
} from './comparisonPreparation'
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
  StorageRequestTimeoutError,
  StorageWorkerError,
  type StorageWorkerClient
} from './workerClient'

export const MAX_QUEUED_EXPLORER_READS = 16
export const COMPARISON_PREPARATION_TIMEOUT_MS = 60_000

type ComparisonWorkspace = Pick<ComparisonPreparationRequest, 'pair' | 'id' | 'scope'>
type ComparisonWorkScope = ComparisonWorkspace['scope']
interface AdoptedWorkspace extends ComparisonWorkspace {
  readonly selectionId: string
  directories: boolean
}
interface PreparingComparison extends ComparisonWorkspace {
  readonly selectionId: string
  started: boolean
  promise: Promise<void>
}

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
  | 'readTrendBatch'
  | 'getInsightsCategories'
  | 'getInsightsSizeDistribution'
  | 'getInsightsObservations'
  | 'listInsightsExtensions'
  | 'listInsightsLargestFiles'
  | 'listInsightsLargestDirectories'
>

export type ComparisonQueries = Pick<
  StorageWorkerClient,
  | 'getScan'
  | 'requireValidatedScan'
  | 'listComparisonMatches'
  | 'getComparisonSummary'
  | 'listComparisonFileChanges'
  | 'listComparisonDirectoryChanges'
>

/** A request that could not be sent, or a read whose reply can no longer be used. */
export class StorageUnavailableError extends StorageWorkerError {
  constructor(message = 'Saved scan storage is unavailable.') {
    super({ name: 'StorageUnavailableError', message, code: null, sqliteCode: null })
  }
}

export class StorageSchedulingError extends StorageWorkerError {
  constructor(code: 'SCAN_COMPARISON_BUSY' | 'COMPARISON_SCAN_ACTIVE') {
    super({
      name: 'StorageSchedulingError',
      code,
      message:
        code === 'SCAN_COMPARISON_BUSY'
          ? 'A comparison is using saved scan storage. Retry the scan when it finishes.'
          : 'Comparison is available after the scan finishes.',
      sqliteCode: null
    })
  }
}

interface Job {
  readonly read: boolean
  readonly comparison: boolean
  readonly run: (client: StorageWorkerClient) => Promise<void>
  readonly reject: (error: Error) => void
  readonly drop: (error: Error) => void
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
  private startingScan = false
  private preparingComparison?: PreparingComparison
  private comparisonWorkspace?: AdoptedWorkspace
  private comparisonReaders = 0
  private workspaceCleanup?: {
    readonly id: string
    readonly job: Job
    readonly promise: Promise<void>
  }
  private readonly reads: Job[] = []
  private readsStopped = false
  private readonly readLifetime = new AbortController()

  constructor(ready: Promise<StorageWorkerClient>) {
    void ready.then(
      (client) => {
        this.client = client
        void client.waitForExit().then(() => this.fail())
        this.drain()
      },
      () => this.fail()
    )
  }

  get readSignal(): AbortSignal {
    return this.readLifetime.signal
  }

  readPair<T>(
    signal: AbortSignal,
    query: (client: ComparisonQueries) => Promise<T>,
    pair: ComparisonPair,
    selectionId?: string,
    scope: ComparisonWorkScope = 'workspace'
  ): Promise<T> {
    if (!selectionId) return this.enqueue(query, signal, pair)
    if (
      this.comparisonReaders >=
      MAX_QUEUED_EXPLORER_READS + Number(this.active?.comparison === true)
    )
      return Promise.reject(
        new StorageUnavailableError('Saved scan storage is busy. Retry the request.')
      )
    this.comparisonReaders++
    const { baselineScanId, targetScanId } = pair
    return this.ensureComparisonWorkspace(
      { baselineScanId, targetScanId },
      selectionId,
      scope,
      signal
    )
      .then(() => this.enqueue(query, signal, pair))
      .finally(() => {
        this.comparisonReaders--
      })
  }

  releaseComparisonWorkspace(): void {
    const workspace = this.comparisonWorkspace
    if (!workspace) return
    this.comparisonWorkspace = undefined
    void this.discardComparisonWorkspace(workspace)
  }

  private async ensureComparisonWorkspace(
    pair: ComparisonPair,
    selectionId: string,
    scope: ComparisonWorkScope,
    signal: AbortSignal
  ): Promise<void> {
    this.assertComparisonAvailable()
    if (signal.aborted) throw new StorageUnavailableError('Comparison preparation was cancelled.')
    const active = this.comparisonWorkspace
    if (active?.selectionId === selectionId && (scope === 'workspace' || active.directories)) return
    const preparing = this.preparingComparison
    if (preparing) {
      if (preparing.selectionId === selectionId && preparing.scope === scope)
        return preparing.promise
      await preparing.promise.catch(() => {})
      return this.ensureComparisonWorkspace(pair, selectionId, scope, signal)
    }
    if (scope === 'directories' && active?.selectionId !== selectionId) {
      await this.ensureComparisonWorkspace(pair, selectionId, 'workspace', signal)
      return this.ensureComparisonWorkspace(pair, selectionId, scope, signal)
    }
    const completion = Promise.withResolvers<void>()
    const candidate = {
      pair,
      scope,
      selectionId,
      id: randomUUID(),
      started: false,
      promise: completion.promise
    }
    this.preparingComparison = candidate
    void this.prepareComparisonWorkspace(candidate, signal).then(
      completion.resolve,
      completion.reject
    )
    return completion.promise
  }

  private async prepareComparisonWorkspace(
    candidate: PreparingComparison,
    signal: AbortSignal
  ): Promise<void> {
    const budget = new AbortController()
    const timer = setTimeout(() => budget.abort(), COMPARISON_PREPARATION_TIMEOUT_MS)
    const lifetime = AbortSignal.any([signal, budget.signal])
    let release: (() => void) | undefined
    try {
      release = this.protection.reservePair(
        candidate.pair.baselineScanId,
        candidate.pair.targetScanId
      )
      const { id, pair, scope, selectionId } = candidate
      const step = (action: 'start' | 'advance'): Promise<ComparisonPreparationStatus> =>
        this.enqueue(
          (client) => {
            candidate.started = true
            return client.prepareComparisonWorkspace({ id, pair, scope, action })
          },
          lifetime,
          pair
        )
      let status = await step('start')
      while (status.phase !== 'ready') {
        const next = await step('advance')
        if (next.completed !== status.completed + 1)
          throw new Error('Comparison preparation did not progress.')
        status = next
      }
      if (lifetime.aborted)
        throw new StorageUnavailableError('Comparison preparation was cancelled.')
      if (scope === 'workspace')
        this.comparisonWorkspace = { id, pair, scope, selectionId, directories: false }
      else if (this.comparisonWorkspace?.selectionId === selectionId)
        this.comparisonWorkspace.directories = true
      else throw new StorageUnavailableError('The comparison workspace is no longer active.')
    } catch (error) {
      if (candidate.started && this.client?.isReady)
        await this.discardComparisonWorkspace(candidate)
      if (budget.signal.aborted && !signal.aborted)
        throw new StorageRequestTimeoutError('Comparison preparation exceeded its time budget.')
      throw error
    } finally {
      clearTimeout(timer)
      release?.()
      if (this.preparingComparison === candidate) this.preparingComparison = undefined
    }
  }

  private discardComparisonWorkspace(workspace: ComparisonWorkspace): Promise<void> {
    if (this.failure || this.readsStopped) return Promise.resolve()
    const queued = this.workspaceCleanup
    if (queued)
      return queued.id === workspace.id
        ? queued.promise
        : queued.promise.then(() => this.discardComparisonWorkspace(workspace))
    const { promise, resolve } = Promise.withResolvers<void>()
    const { id, pair, scope } = workspace
    const job: Job = {
      read: false,
      comparison: true,
      run: async (client) => {
        try {
          await client.prepareComparisonWorkspace({ action: 'discard', id, pair, scope })
        } catch {
          // Worker termination also releases all connection-local temporary state.
          if (!client.isReady) await client.waitForExit()
        } finally {
          resolve()
        }
      },
      reject: () => resolve(),
      drop: () => resolve()
    }
    this.workspaceCleanup = { id, job, promise }
    this.drain()
    return promise
  }

  protectComparisonPair(signal: AbortSignal, pair: ComparisonPair): () => void {
    return this.protection.createPairOwner(signal, pair.baselineScanId, pair.targetScanId)
  }

  assertComparisonAvailable(): void {
    if (this.startingScan || this.buildingScanId !== undefined)
      throw new StorageSchedulingError('COMPARISON_SCAN_ACTIVE')
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
      !this.startingScan &&
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

  async beginScan(scan: BuildingScan): Promise<void> {
    if (this.readsStopped) throw new StorageUnavailableError('Saved scan storage is shutting down.')
    if (this.client && !this.client.isReady) this.fail()
    if (this.failure) throw this.failure
    if (this.active?.comparison || this.preparingComparison?.started)
      throw new StorageSchedulingError('SCAN_COMPARISON_BUSY')
    if (this.startingScan || this.write)
      throw new StorageUnavailableError('Saved scan storage is busy. Retry the request.')

    // Hold admission before enqueueing beginScan, including when unrelated work is in flight.
    this.startingScan = true
    try {
      for (let index = this.reads.length - 1; index >= 0; index--) {
        if (this.reads[index].comparison)
          this.reads.splice(index, 1)[0].drop(new StorageSchedulingError('COMPARISON_SCAN_ACTIVE'))
      }
      await this.enqueue(async (client) => {
        await client.beginScan(scan)
        this.buildingScanId = scan.id
      })
    } finally {
      this.startingScan = false
      this.drain()
      this.notifyIdle()
    }
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
    this.readLifetime.abort()
    const error = new StorageUnavailableError('Saved scan storage is shutting down.')
    for (const job of this.reads.splice(0)) job.drop(error)
    this.workspaceCleanup?.job.drop(error)
    this.workspaceCleanup = undefined
    if (this.active?.read) this.active.reject(error)
  }

  private enqueue<T>(
    operation: (client: StorageWorkerClient) => Promise<T>,
    signal?: AbortSignal,
    source?: string | ComparisonPair,
    deletion = false
  ): Promise<T> {
    if (this.client && !this.client.isReady) this.fail()
    if (this.failure) return Promise.reject(this.failure)
    const read = signal !== undefined
    const comparison = source !== undefined && typeof source !== 'string'
    if (read && (signal.aborted || this.readsStopped)) {
      return Promise.reject(new StorageUnavailableError('The storage request is no longer active.'))
    }
    let release: (() => void) | undefined
    try {
      if (comparison) this.assertComparisonAvailable()
      if (read ? this.reads.length >= MAX_QUEUED_EXPLORER_READS : !deletion && this.write)
        throw new StorageUnavailableError('Saved scan storage is busy. Retry the request.')
      if (typeof source === 'string') release = this.protection.reserve(source)
      else if (source)
        release = this.protection.reservePair(source.baselineScanId, source.targetScanId)
    } catch (error) {
      return Promise.reject(error)
    }
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearReadHandlers = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const cancelRead = (error: Error): void => {
      const index = this.reads.indexOf(job)
      if (index < 0) job.reject(error)
      else {
        this.reads.splice(index, 1)
        job.drop(error)
      }
    }
    const abort = (): void =>
      cancelRead(new StorageUnavailableError('The storage request is no longer active.'))
    const job: Job = {
      read,
      comparison,
      run: async (client) => {
        clearTimeout(timer)
        try {
          resolve(await operation(client))
        } catch (error) {
          // Preserve the original error for a dispatched write whose outcome may be unknown.
          const timedOut = comparison && error instanceof StorageRequestTimeoutError
          reject(read && !client.isReady && !timedOut ? new StorageUnavailableError() : error)
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
      timer = setTimeout(() => {
        const message = 'Waiting for saved scan storage timed out. Retry the request.'
        cancelRead(
          comparison
            ? new StorageRequestTimeoutError(message)
            : new StorageUnavailableError(message)
        )
      }, STORAGE_REQUEST_TIMEOUT_MS)
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
    const cleanup =
      !this.startingScan && !this.buildingScanId ? this.workspaceCleanup?.job : undefined
    const job = this.write ?? this.deletion ?? cleanup ?? this.reads.shift()
    if (!job) {
      this.notifyIdle()
      return
    }
    if (job === this.write) this.write = undefined
    if (job === this.deletion) this.deletion = undefined
    if (job === cleanup) this.workspaceCleanup = undefined
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
    this.readLifetime.abort()
    for (const job of this.reads.splice(0)) job.drop(this.failure)
    this.write?.reject(this.failure)
    this.write = undefined
    this.deletion?.reject(this.failure)
    this.deletion = undefined
    this.workspaceCleanup?.job.drop(this.failure)
    this.workspaceCleanup = undefined
  }
}
