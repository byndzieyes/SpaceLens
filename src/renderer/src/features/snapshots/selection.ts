import { useMemo } from 'react'
import type {
  ScannerIpcErrorCode,
  ScannerIpcResult,
  ScanStateSnapshot,
  SpaceLensAPI
} from '../../../../shared/ipc'
import type { ScanSnapshotAvailability } from '../../../../shared/snapshot'
import type {
  SnapshotSelection,
  SnapshotSelectionResolution,
  SnapshotView
} from '../../../../shared/snapshotSelection'

type SelectionError = Extract<ScannerIpcResult<never>, { ok: false }>['error']
type SettledSelection =
  | {
      readonly status: 'resolved' | 'empty'
      readonly selection: SnapshotSelection
      readonly resolution: SnapshotSelectionResolution
      readonly latestVersion: number
    }
  | {
      readonly status: 'unavailable' | 'failed'
      readonly selection: SnapshotSelection
      readonly error: SelectionError
    }

export type SnapshotSelectionState =
  { readonly status: 'pending'; readonly selection: SnapshotSelection } | SettledSelection

const selectionError = (code: ScannerIpcErrorCode, message: string): SelectionError => ({
  code,
  message
})

type SelectionAPI = Pick<
  SpaceLensAPI,
  | 'prepareSnapshotSelection'
  | 'adoptSnapshotSelection'
  | 'releaseSnapshotSelection'
  | 'onScanStateChanged'
>

/** One controller coordinates both views and their navigation. Page reads keep their own loading state. */
export class SnapshotSelections {
  private readonly views = new Map<SnapshotView, SnapshotSelectionState>()
  private latestVersion = 0
  private revision = -1
  private latest: ScanStateSnapshot['latestCompleted']

  constructor(private readonly api: SelectionAPI) {}

  get latestCompleted(): ScanStateSnapshot['latestCompleted'] {
    return this.latest
  }

  readonly observeScanState = (snapshot: ScanStateSnapshot): void => {
    if (
      snapshot.revision <= this.revision ||
      snapshot.latestCompleted === undefined ||
      snapshot.publicationStatus === 'loading'
    )
      return
    this.revision = snapshot.revision
    if (this.latest === undefined || this.latest?.id !== snapshot.latestCompleted?.id) {
      this.latestVersion++
    }
    this.latest = snapshot.latestCompleted
  }

  subscribeScanState(listener?: Parameters<SpaceLensAPI['onScanStateChanged']>[0]): () => void {
    return this.api.onScanStateChanged((snapshot) => {
      this.observeScanState(snapshot)
      listener?.(snapshot)
    })
  }

  get(view: SnapshotView): SnapshotSelectionState | undefined {
    return this.views.get(view)
  }

  async select(
    view: SnapshotView,
    selection: SnapshotSelection
  ): Promise<SettledSelection | undefined> {
    const pending: SnapshotSelectionState = { status: 'pending', selection }
    this.views.set(view, pending)
    const latestVersion = this.latestVersion
    const current = (): boolean => this.views.get(view) === pending
    const fail = (error: SelectionError): SettledSelection => {
      const status = ['SNAPSHOT_EXPIRED', 'SNAPSHOT_UNAVAILABLE', 'SNAPSHOT_IN_USE'].includes(
        error.code
      )
        ? 'unavailable'
        : 'failed'
      const outcome = { status, selection, error } as const
      this.views.set(view, outcome)
      return outcome
    }
    try {
      const prepared = await this.api.prepareSnapshotSelection({ view, selection })
      if (!current()) return undefined
      if (!prepared.ok) return fail(prepared.error)
      const { ticket, resolution } = prepared.value
      const adopted = await this.api.adoptSnapshotSelection({ view, ticket })
      if (!current()) return undefined
      if (!adopted.ok) return fail(adopted.error)
      const outcome = {
        status:
          resolution.mode === 'follow-latest' && !resolution.availability.snapshot
            ? 'empty'
            : 'resolved',
        selection,
        resolution,
        latestVersion
      } as const
      this.views.set(view, outcome)
      return outcome
    } catch {
      if (!current()) return undefined
      return fail(selectionError('UNAVAILABLE', 'The snapshot selection could not be loaded.'))
    }
  }

  async loadForCurrentView(
    view: SnapshotView,
    selection: SnapshotSelection,
    current: () => boolean,
    handoff?: Promise<SettledSelection | undefined>
  ): Promise<ScannerIpcResult<ScanSnapshotAvailability>> {
    const prepared = handoff && (await handoff)
    if (!current())
      return { ok: false, error: selectionError('UNAVAILABLE', 'The snapshot selection changed.') }
    const outcome =
      prepared && prepared === this.get(view) && this.usableHandoff(prepared)
        ? prepared
        : await this.select(view, selection)
    if (!outcome || !current())
      return { ok: false, error: selectionError('UNAVAILABLE', 'The snapshot selection changed.') }
    if ('error' in outcome) return { ok: false, error: outcome.error }
    if (outcome.resolution.mode === 'explicit')
      return {
        ok: false,
        error: selectionError(
          'SNAPSHOT_UNAVAILABLE',
          'Historical snapshots cannot be opened in this view yet.'
        )
      }
    return { ok: true, value: outcome.resolution.availability }
  }

  release(view: SnapshotView): void {
    if (!this.views.delete(view)) return
    // A document invalidation also releases Main's ownership if transport has gone away.
    void this.api.releaseSnapshotSelection({ view }).catch(() => {})
  }

  private usableHandoff(handoff: SettledSelection): boolean {
    if ('error' in handoff || handoff.resolution.mode === 'explicit') return true
    const scanId = handoff.resolution.availability.snapshot?.entries.scanId ?? null
    return (
      this.latestVersion === handoff.latestVersion ||
      (this.latestCompleted !== undefined && (this.latestCompleted?.id ?? null) === scanId)
    )
  }
}

export type SnapshotHandoff = NonNullable<Awaited<ReturnType<SnapshotSelections['select']>>>

export interface ViewSnapshotOptions {
  readonly controller: SnapshotSelections
  readonly selection: SnapshotSelection
  readonly handoff?: Promise<SnapshotHandoff | undefined>
}

export function useSnapshotSelections(shared?: SnapshotSelections): SnapshotSelections {
  return useMemo(() => shared ?? new SnapshotSelections(window.spaceLens), [shared])
}
