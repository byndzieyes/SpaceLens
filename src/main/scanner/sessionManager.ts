import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { RecentScanSummary, ScanProgress, ScanSessionState } from '../../shared/scan'
export type { ScanSessionState } from '../../shared/scan'
import { ScanCancelledError } from './cancellation'
import { batchOperations, ScanStorageError, writeScan, type ScanPersistence } from './persistence'
import type { BuildingScan } from '../storage/payloads'
import { ScanProgressTracker } from './progress'
import {
  DEFAULT_SNAPSHOT_LIMITS,
  ScanSnapshotStorage,
  SnapshotAccessError,
  validateSnapshotRequest,
  validateTreemapRequest,
  type SnapshotLimits
} from './snapshot'
import type {
  ScanDirectoryPage,
  ScanDirectoryRequest,
  ScanDirectoryTreemap,
  ScanDirectoryTreemapRequest,
  ScanEntryRequest,
  ScanSnapshotAvailability
} from '../../shared/snapshot'
import type { FileEntry } from '../../shared/scan'
import type { ScanSummaryEvent } from './summary'
import type { ScanEventConsumer } from './workerClient'
import { serializeWorkerFailure } from './workerProtocol'
import { runScannerWorker } from './workerRunner'

/** Synchronous observers only; asynchronous work belongs in the event consumer. */
export type ScanSessionSubscriber = (state: ScanSessionState) => undefined

interface ActiveScan {
  readonly id: string
  readonly controller: AbortController
  readonly tracker: ScanProgressTracker
  readonly snapshot: ScanSnapshotStorage
  readonly done: Promise<ScanSessionState>
  acceptingEvents: boolean
  publishing: boolean
  batch?: Promise<void>
  errorCount: number
}

interface StartedScan {
  readonly scanId: string
  readonly done: Promise<ScanSessionState>
}

function copy(state: ScanSessionState): ScanSessionState {
  return {
    session: { ...state.session, summary: { ...state.session.summary } },
    progress: { ...state.progress },
    failure: state.failure === null ? null : { ...state.failure }
  }
}

/**
 * One active attempt and the latest state, with bounded temporary entry retention
 * and no event history. start() resolves terminal state for all worker outcomes; invalid,
 * concurrent, or disposed starts reject. Await it before starting another scan.
 */
export class ScanSessionManager {
  private latestCompleted: RecentScanSummary | null = null
  private state: ScanSessionState | null = null
  private active: ActiveScan | null = null
  private readonly subscribers = new Set<ScanSessionSubscriber>()
  private disposed = false
  private disposal: Promise<void> | undefined
  private published: ScanSnapshotStorage | null = null
  private unavailable: ScanSnapshotAvailability['unavailable'] = null
  private readonly snapshotLimits: SnapshotLimits

  constructor(
    limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
    private readonly storageReady?: Promise<ScanPersistence>
  ) {
    if (
      !Number.isSafeInteger(limits.maxEntries) ||
      limits.maxEntries < 0 ||
      !Number.isSafeInteger(limits.maxEstimatedBytes) ||
      limits.maxEstimatedBytes < 0
    )
      throw new RangeError('Snapshot limits must be non-negative safe integers.')
    this.snapshotLimits = { ...limits }
  }

  getScanSnapshot(): ScanSnapshotAvailability {
    return {
      snapshot: this.published?.describe() ?? null,
      unavailable: this.getSnapshotUnavailable()
    }
  }

  /** Small notification metadata; never copies entries or root paths on progress updates. */
  getSnapshotUnavailable(): ScanSnapshotAvailability['unavailable'] {
    return this.unavailable === null ? null : { ...this.unavailable }
  }

  getScanEntry(request: ScanEntryRequest): FileEntry {
    validateSnapshotRequest(request, false)
    return this.snapshotFor(request.scanId).getEntry(request.entryId)
  }

  listScanDirectory(request: ScanDirectoryRequest): ScanDirectoryPage {
    validateSnapshotRequest(request, true)
    return this.snapshotFor(request.scanId).listDirectory(request)
  }

  getScanDirectoryTreemap(request: ScanDirectoryTreemapRequest): ScanDirectoryTreemap {
    validateTreemapRequest(request)
    return this.snapshotFor(request.scanId).getDirectoryTreemap(request)
  }

  private snapshotFor(scanId: string): ScanSnapshotStorage {
    if (this.published?.scanId === scanId) return this.published
    if (!this.published || this.unavailable?.scanId === scanId || this.state?.session.id === scanId)
      throw new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'This scan has no available snapshot.')
    throw new SnapshotAccessError(
      'SNAPSHOT_EXPIRED',
      'This snapshot reference is no longer available.'
    )
  }

  getLatestCompleted(): RecentScanSummary | null {
    return this.latestCompleted === null ? null : { ...this.latestCompleted }
  }

  getState(): ScanSessionState | null {
    return this.state === null ? null : copy(this.state)
  }

  /** Observe creation, batch progress, and settlement; use getState() for initial state. */
  subscribe(subscriber: ScanSessionSubscriber): () => void {
    if (this.disposed) throw new Error('Scan session manager is disposed.')
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  async start(rootPath: string, consume: ScanEventConsumer = () => {}): Promise<ScanSessionState> {
    return this.reserve(rootPath, consume).done
  }

  /** Resolve only after persistent admission. The returned scan settles independently. */
  async launch(rootPath: string, confirmStart: () => Promise<void>): Promise<StartedScan> {
    const { accepted, scanId, done } = this.reserve(rootPath, () => {}, confirmStart)
    await Promise.race([accepted, done])
    return { scanId, done }
  }

  private reserve(
    rootPath: string,
    consume: ScanEventConsumer,
    confirmStart?: () => Promise<void>
  ): StartedScan & { accepted: Promise<void> } {
    if (this.disposed) throw new Error('Scan session manager is disposed.')
    if (this.active !== null) throw new Error('A scan is already active.')
    if (typeof rootPath !== 'string' || rootPath.length === 0)
      throw new TypeError('Root path must not be empty.')
    const id = randomUUID()
    const tracker = new ScanProgressTracker(id)
    const path = resolve(rootPath)
    const session: BuildingScan = {
      id,
      rootPath: path,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
    }
    const accepted = Promise.withResolvers<void>()
    const activate = (): void => {
      active.acceptingEvents = true
      this.state = { session, progress: tracker.snapshot(), failure: null }
      this.notify()
      accepted.resolve()
    }
    const active: ActiveScan = {
      id,
      tracker,
      snapshot: new ScanSnapshotStorage(id, path, this.snapshotLimits),
      controller: new AbortController(),
      acceptingEvents: false,
      publishing: false,
      errorCount: 0,
      // Establish the active reservation before callbacks can cancel/dispose/reenter.
      done: Promise.resolve().then(async () => {
        let storage: ScanPersistence | undefined
        if (this.storageReady) {
          try {
            storage = await this.prepareStorage(active, session, this.storageReady, confirmStart)
          } catch (error) {
            active.snapshot.discard()
            this.active = null
            throw error
          }
          activate()
        }
        return this.execute(active, path, consume, storage)
      })
    }
    this.active = active
    if (!this.storageReady) activate()
    return { scanId: id, accepted: accepted.promise, done: active.done }
  }

  private async prepareStorage(
    active: ActiveScan,
    session: BuildingScan,
    ready: Promise<ScanPersistence>,
    confirmStart?: () => Promise<void>
  ): Promise<ScanPersistence> {
    const storage = await ready.catch((error: unknown) => {
      if (active.controller.signal.aborted) throw new ScanCancelledError()
      throw new ScanStorageError('initializing scan storage', error)
    })
    if (active.controller.signal.aborted) throw new ScanCancelledError()
    await writeScan('starting the scan', () => storage.beginScan(session))
    const { signal } = active.controller
    try {
      if (signal.aborted) throw new ScanCancelledError()
      if (confirmStart) {
        const cancelled = Promise.withResolvers<never>()
        const onAbort = (): void => cancelled.reject(new ScanCancelledError())
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          await Promise.race([confirmStart(), cancelled.promise])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }
      if (signal.aborted) throw new ScanCancelledError()
      return storage
    } catch (error) {
      await writeScan('discarding the incomplete scan', () =>
        storage.discardBuildingScan(active.id)
      )
      throw error
    }
  }

  /** A publication already sent to SQLite must settle before another scan can start. */
  cancel(): boolean {
    const active = this.active
    if (!active || active.publishing) return false
    active.controller.abort()
    return true
  }

  /** Permanently reject new starts, remove observers, and await active worker cleanup. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.subscribers.clear()
    this.cancel()
    this.published?.discard()
    this.published = null
    this.active?.snapshot.discard()
    this.unavailable = null
    this.disposal =
      this.active?.done.then(
        () => undefined,
        (error: unknown) => {
          if (!(error instanceof ScanCancelledError)) throw error
        }
      ) ?? Promise.resolve()
    return this.disposal
  }

  private current(active: ActiveScan): boolean {
    return this.active === active && active.acceptingEvents && !active.controller.signal.aborted
  }

  private refresh(active: ActiveScan): void {
    const progress = active.tracker.snapshot()
    this.state = {
      ...this.state!,
      progress,
      session: {
        ...this.state!.session,
        summary: {
          fileCount: progress.processedFileCount,
          directoryCount: progress.processedDirectoryCount,
          totalBytes: progress.processedBytes,
          errorCount: active.errorCount
        }
      }
    }
  }

  private async execute(
    active: ActiveScan,
    path: string,
    consume: ScanEventConsumer,
    storage?: ScanPersistence
  ): Promise<ScanSessionState> {
    let status: 'completed' | 'cancelled' | 'failed' = 'completed'
    let failure: unknown
    let completedResult: ScanSummaryEvent | null = null
    let completedAt: string | undefined
    try {
      const result = await runScannerWorker(
        path,
        active.id,
        async (event) => {
          if (!this.current(active)) return
          // The consumer receives its own event, so mutations cannot alter accounting
          // or the runner's final-summary/progress validation.
          await consume(structuredClone(event))
          if (!this.current(active)) return
          if (event.type === 'error') {
            if (active.errorCount === Number.MAX_SAFE_INTEGER)
              throw new RangeError('Scan error count overflow.')
            active.errorCount++
          }
          active.tracker.accept(event)
          if (!this.disposed) active.snapshot.accept(event)
          this.refresh(active)
        },
        {
          signal: active.controller.signal,
          beforeAck:
            storage &&
            ((events) => {
              if (!this.current(active)) return
              const operations = batchOperations(events)
              active.batch = writeScan('writing a scan batch', () =>
                storage.applyBatch(active.id, operations)
              )
              return active.batch
            }),
          onProgress: (progress) => {
            if (!this.current(active)) return
            const known = active.tracker.snapshot()
            if (
              Object.keys(known).some(
                (key) => known[key as keyof ScanProgress] !== progress[key as keyof ScanProgress]
              )
            ) {
              throw new Error('Worker progress differs from consumed session events.')
            }
            this.notify()
          }
        }
      ).finally(() => {
        active.acceptingEvents = false
      })
      if (active.batch) await active.batch
      if (active.controller.signal.aborted) throw new ScanCancelledError()
      active.tracker.accept(result)
      if (result.summary.errorCount !== active.errorCount)
        throw new Error('Worker error count differs from consumed session events.')
      this.state = {
        ...this.state!,
        session: { ...this.state!.session, summary: { ...result.summary } }
      }
      completedAt = new Date().toISOString()
      if (storage) {
        const completed = {
          ...this.state.session,
          status: 'completed' as const,
          finishedAt: completedAt
        }
        // From this point cancellation would race an atomic publication already in flight.
        active.publishing = true
        await writeScan('publishing the scan', () =>
          storage.publishScan(completed, result.rootEntryId)
        )
      }
      completedResult = result
    } catch (error) {
      if (active.controller.signal.aborted && error instanceof ScanCancelledError)
        status = 'cancelled'
      else {
        status = 'failed'
        failure = error
      }
    }
    if (status !== 'completed' && storage) {
      // Scanner cancellation can settle before an in-flight pre-ACK callback returns.
      try {
        await active.batch
      } catch (error) {
        status = 'failed'
        failure = error
      }
      if (!(failure instanceof ScanStorageError && failure.uncertain)) {
        try {
          await writeScan('discarding the incomplete scan', () =>
            storage.discardBuildingScan(active.id)
          )
        } catch (error) {
          if (status === 'failed') console.error('Scan failed before storage cleanup.', failure)
          status = 'failed'
          failure = error
        }
      }
    }
    if (failure instanceof ScanStorageError) console.error('Scan persistence failed.', failure)
    this.state = {
      ...this.state!,
      failure: status === 'failed' ? serializeWorkerFailure(failure) : null,
      session: {
        ...this.state!.session,
        status,
        finishedAt: status === 'completed' ? completedAt! : new Date().toISOString()
      }
    }
    if (this.state.session.status === 'completed') {
      const session = this.state.session
      if (
        !this.disposed &&
        completedResult &&
        active.snapshot.complete(completedResult, session.finishedAt)
      ) {
        this.published?.discard()
        this.published = active.snapshot
        this.unavailable = null
      } else if (!this.disposed) {
        this.unavailable = {
          scanId: active.id,
          reason: active.snapshot.unavailableReason ?? 'invalid-data'
        }
      }
      this.latestCompleted = {
        id: session.id,
        path: session.rootPath,
        completedAt: session.finishedAt,
        totalBytes: session.summary.totalBytes,
        fileCount: session.summary.fileCount,
        errorCount: session.summary.errorCount
      }
    }
    if (this.published !== active.snapshot) active.snapshot.discard()
    const terminal = copy(this.state)
    this.notify()
    this.active = null
    return terminal
  }

  private notify(): void {
    const snapshot = this.getState()!
    // A fixed subscriber snapshot prevents reentrant subscriptions from extending a notification.
    for (const subscriber of [...this.subscribers]) {
      if (!this.subscribers.has(subscriber)) continue
      try {
        const returned: unknown = subscriber(copy(snapshot))
        if (returned !== undefined) {
          // Guard JavaScript callers too: detach asynchronous observers immediately,
          // handle a possible rejection, and never accumulate pending notifications.
          void Promise.resolve(returned).catch((error) =>
            console.error('Scan session subscriber failed:', error)
          )
          throw new TypeError('Scan session subscribers must be synchronous and return undefined.')
        }
      } catch (error) {
        this.subscribers.delete(subscriber)
        console.error('Scan session subscriber removed:', error)
      }
    }
  }
}
