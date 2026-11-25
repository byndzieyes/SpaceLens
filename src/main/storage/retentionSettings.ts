import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import {
  DEFAULT_SCAN_HISTORY_LIMIT,
  isScanHistoryRetentionSettings,
  type ScanHistoryRetentionSettings
} from '../../shared/history'
import { SnapshotAccessError } from './snapshotAccess'

export class RetentionSettingsError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'INTERNAL_ERROR',
    message: string,
    cause?: unknown
  ) {
    super(message, { cause })
  }
}

/** The profile is single-instance. Only a completed rename changes the cached setting. */
export class RetentionSettingsStore {
  readonly restored: Promise<void>
  private settings: ScanHistoryRetentionSettings | undefined
  private loadError: RetentionSettingsError | undefined
  private updating: Promise<ScanHistoryRetentionSettings> | undefined
  private stopped = false

  constructor(private readonly path: string) {
    this.restored = this.load().catch((error: unknown) => {
      this.loadError = new RetentionSettingsError(
        'INTERNAL_ERROR',
        'Could not restore history retention settings. Save a valid limit to resume pruning.',
        error
      )
    })
  }

  get maintenanceLimit(): number | undefined {
    return this.updating ? undefined : this.settings?.maxCompletedSnapshots
  }

  async get(): Promise<ScanHistoryRetentionSettings> {
    await this.restored
    if (this.loadError) throw this.loadError
    return { ...this.settings! }
  }

  async set(value: unknown): Promise<ScanHistoryRetentionSettings> {
    if (!isScanHistoryRetentionSettings(value))
      throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid history retention limit.')
    if (this.stopped || this.updating)
      throw new RetentionSettingsError('UNAVAILABLE', 'History retention settings are busy.')

    const settings = { maxCompletedSnapshots: value.maxCompletedSnapshots }
    this.updating = this.restored.then(async () => {
      try {
        await this.persist(settings)
      } catch (error) {
        throw new RetentionSettingsError(
          'INTERNAL_ERROR',
          'Could not save history retention settings.',
          error
        )
      }
      this.settings = settings
      this.loadError = undefined
      return { ...settings }
    })
    try {
      return await this.updating
    } finally {
      this.updating = undefined
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.updating?.catch(() => {})
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      this.settings = { maxCompletedSnapshots: DEFAULT_SCAN_HISTORY_LIMIT }
      return
    }
    const value: unknown = JSON.parse(text)
    if (!isScanHistoryRetentionSettings(value))
      throw new Error('Invalid persisted history retention settings.')
    this.settings = value
  }

  private async persist(settings: ScanHistoryRetentionSettings): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      try {
        await file.writeFile(`${JSON.stringify(settings)}\n`, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
