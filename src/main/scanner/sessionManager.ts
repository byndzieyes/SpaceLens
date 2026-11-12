import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { RecentScanSummary, ScanProgress, ScanSessionState } from '../../shared/scan'
export type { ScanSessionState } from '../../shared/scan'
import { ScanCancelledError } from './cancellation'
import { ScanProgressTracker } from './progress'
import type { ScanEventConsumer } from './workerClient'
import { serializeWorkerFailure, type ScannerWorkerFailure } from './workerProtocol'
import { runScannerWorker } from './workerRunner'

/** Synchronous observers only; asynchronous work belongs in the event consumer. */
export type ScanSessionSubscriber = (state: ScanSessionState) => undefined

interface ActiveScan {
  readonly id: string
  readonly controller: AbortController
  readonly tracker: ScanProgressTracker
  readonly done: Promise<ScanSessionState>
  errorCount: number
}

function copy(state: ScanSessionState): ScanSessionState {
  return {
    session: { ...state.session, summary: { ...state.session.summary } },
    progress: { ...state.progress },
    failure: state.failure === null ? null : { ...state.failure }
  }
}

/**
 * One active attempt and the latest state, with O(1) scan metadata and no event
 * history. start() resolves a terminal snapshot for all worker outcomes; invalid,
 * concurrent, or disposed starts reject. Await it before starting another scan.
 */
export class ScanSessionManager {
  private latestCompleted: RecentScanSummary | null = null
  private state: ScanSessionState | null = null
  private active: ActiveScan | null = null
  private readonly subscribers = new Set<ScanSessionSubscriber>()
  private disposed = false
  private disposal: Promise<void> | undefined

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
    if (this.disposed) throw new Error('Scan session manager is disposed.')
    if (this.active !== null) throw new Error('A scan is already active.')
    if (typeof rootPath !== 'string' || rootPath.length === 0)
      throw new TypeError('Root path must not be empty.')
    const id = randomUUID()
    const tracker = new ScanProgressTracker(id)
    const path = resolve(rootPath)
    this.state = {
      session: {
        id,
        rootPath: path,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
      },
      progress: tracker.snapshot(),
      failure: null
    }
    const active: ActiveScan = {
      id,
      tracker,
      controller: new AbortController(),
      errorCount: 0,
      // Establish the active reservation before callbacks can cancel/dispose/reenter.
      done: Promise.resolve().then(() => this.execute(active, path, consume))
    }
    this.active = active
    this.notify()
    return active.done
  }

  /** Remains running until worker settlement; repeated requests have no effect. */
  cancel(): void {
    this.active?.controller.abort()
  }

  /** Permanently reject new starts, remove observers, and await active worker cleanup. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.subscribers.clear()
    this.cancel()
    this.disposal = this.active?.done.then(() => undefined) ?? Promise.resolve()
    return this.disposal
  }

  private current(active: ActiveScan): boolean {
    return this.active === active && this.state?.session.status === 'running'
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
    consume: ScanEventConsumer
  ): Promise<ScanSessionState> {
    let status: 'completed' | 'cancelled' | 'failed' = 'completed'
    let failure: ScannerWorkerFailure | null = null
    try {
      const result = await runScannerWorker(
        path,
        active.id,
        async (event) => {
          if (!this.current(active) || active.controller.signal.aborted) return
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
          this.refresh(active)
        },
        {
          signal: active.controller.signal,
          onProgress: (progress) => {
            if (!this.current(active) || active.controller.signal.aborted) return
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
      )
      active.tracker.accept(result)
      if (result.summary.errorCount !== active.errorCount)
        throw new Error('Worker error count differs from consumed session events.')
      this.state = {
        ...this.state!,
        session: { ...this.state!.session, summary: { ...result.summary } }
      }
    } catch (error) {
      if (active.controller.signal.aborted && error instanceof ScanCancelledError)
        status = 'cancelled'
      else {
        status = 'failed'
        failure = serializeWorkerFailure(error)
      }
    }
    this.state = {
      ...this.state!,
      failure,
      session: { ...this.state!.session, status, finishedAt: new Date().toISOString() }
    }
    if (this.state.session.status === 'completed') {
      const session = this.state.session
      this.latestCompleted = {
        id: session.id,
        path: session.rootPath,
        completedAt: session.finishedAt,
        totalBytes: session.summary.totalBytes,
        fileCount: session.summary.fileCount,
        errorCount: session.summary.errorCount
      }
    }
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
