import { setImmediate as yieldToStorage } from 'node:timers/promises'
import type { ScanHistoryRetentionSettings } from '../../shared/history'
import {
  StorageUnavailableError,
  type RetentionOpportunity,
  type ScanStorageCoordinator
} from './coordinator'
import type { CommittedSnapshotDeletion } from './payloads'
import type { RetentionSettingsStore } from './retentionSettings'
import { SnapshotAccessError } from './snapshotAccess'
import { StorageWorkerError } from './workerClient'

type MaintenanceState =
  'idle' | 'waiting' | 'running' | 'protected' | 'failed' | 'uncertain' | 'stopped'

/** One pass in flight. Each pass discovers and deletes at most one snapshot. */
export class HistoryRetention {
  private readonly context = new AbortController()
  private readonly unsubscribe: () => void
  private scheduled: NodeJS.Immediate | undefined
  private active: Promise<void> | undefined
  private requested = false
  private blockedIds: readonly string[] = []
  private state: MaintenanceState = 'idle'
  private pruned: ((result: CommittedSnapshotDeletion) => void) | undefined

  constructor(
    private readonly storage: Pick<
      ScanStorageCoordinator,
      | 'observeRetention'
      | 'retentionIdle'
      | 'findRetentionCandidate'
      | 'pruneSnapshotIfIdle'
      | 'isSnapshotProtected'
    >,
    private readonly settings: RetentionSettingsStore
  ) {
    this.unsubscribe = storage.observeRetention(this.onOpportunity)
    void settings.restored.then(() => this.request())
  }

  get status(): MaintenanceState {
    return this.state
  }

  getSettings(): Promise<ScanHistoryRetentionSettings> {
    return this.settings.get()
  }

  async setSettings(value: unknown): Promise<ScanHistoryRetentionSettings> {
    try {
      const settings = await this.settings.set(value)
      this.request()
      return settings
    } finally {
      // A failed save can still unblock maintenance under the previous setting.
      this.schedule()
    }
  }

  onPruned(listener: (result: CommittedSnapshotDeletion) => void): () => void {
    this.pruned = listener
    return () => {
      if (this.pruned === listener) this.pruned = undefined
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    this.requested = false
    this.context.abort()
    this.unsubscribe()
    if (this.scheduled) clearImmediate(this.scheduled)
    this.scheduled = undefined
    await Promise.all([this.settings.stop(), this.active])
  }

  private readonly onOpportunity = (event: RetentionOpportunity): void => {
    if (
      event.type === 'publication' ||
      event.type === 'manual-deletion' ||
      (event.type === 'released' && this.blockedIds.includes(event.scanId))
    ) {
      this.request()
    } else this.schedule()
  }

  private request(): void {
    if (this.context.signal.aborted || this.state === 'uncertain') return
    this.requested = true
    this.blockedIds = []
    this.schedule()
  }

  private schedule(): void {
    if (
      !this.requested ||
      this.active ||
      this.scheduled ||
      this.context.signal.aborted ||
      this.state === 'uncertain'
    )
      return
    if (this.settings.maintenanceLimit === undefined || !this.storage.retentionIdle) {
      this.state = 'waiting'
      return
    }
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      const limit = this.settings.maintenanceLimit
      if (limit === undefined || !this.storage.retentionIdle) {
        this.state = 'waiting'
        return
      }
      this.requested = false
      this.state = 'running'
      this.active = this.pass(limit)
        .catch(this.handleFailure)
        .finally(() => {
          this.active = undefined
          if (this.state === 'running') this.state = 'idle'
          this.schedule()
        })
    })
  }

  private async pass(limit: number): Promise<void> {
    const candidate = await this.storage.findRetentionCandidate(limit, this.context.signal)
    if (this.context.signal.aborted) return
    if (!candidate) {
      this.requested = true
      return
    }
    if (candidate.totalCount <= limit) return
    if (candidate.building) {
      this.state = 'waiting'
      return
    }
    if (candidate.candidateScanId === null) {
      this.blockedIds = candidate.protectedScanIds.filter((id) => id !== candidate.latestScanId)
      this.state = 'protected'
      if (this.blockedIds.some((id) => !this.storage.isSnapshotProtected(id))) this.requested = true
      return
    }

    // Let the read leave the worker lane, and give scanner writes a turn before admission.
    await yieldToStorage()
    if (this.context.signal.aborted) return
    if (this.settings.maintenanceLimit !== limit) {
      this.requested = true
      return
    }
    const result = await this.storage.pruneSnapshotIfIdle(candidate.candidateScanId, limit)
    if (result) this.pruned?.(result)
    if (!this.context.signal.aborted) this.requested = true
  }

  private readonly handleFailure = (error: unknown): void => {
    if (this.context.signal.aborted) return
    const code =
      error instanceof SnapshotAccessError || error instanceof StorageWorkerError
        ? error.code
        : null
    if (
      code === 'SNAPSHOT_IN_USE' ||
      code === 'SNAPSHOT_EXPIRED' ||
      code === 'SNAPSHOT_UNAVAILABLE'
    ) {
      this.requested = true
      return
    }
    if (error instanceof StorageUnavailableError) {
      this.state = 'waiting'
      return
    }
    this.state = code === 'SNAPSHOT_DELETE_UNCERTAIN' ? 'uncertain' : 'failed'
    console.error('History retention could not confirm a maintenance pass.', error)
  }
}
