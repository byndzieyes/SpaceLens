import { useMemo } from 'react'
import type {
  ScannerIpcErrorCode,
  ScannerIpcResult,
  ScanStateSnapshot,
  SpaceLensAPI
} from '../../../../shared/ipc'
import type { ScanSnapshot, ScanSnapshotAvailability } from '../../../../shared/snapshot'
import type {
  SnapshotSelection,
  SnapshotSelectionResolution,
  SnapshotView
} from '../../../../shared/snapshotSelection'

type SelectionError = Extract<ScannerIpcResult<never>, { ok: false }>['error']
type AdoptedSelection = {
  readonly status: 'resolved' | 'empty'
  readonly selection: SnapshotSelection
  readonly resolution: SnapshotSelectionResolution
  readonly explorerSnapshot: ScanSnapshot | null
  readonly latestVersion: number
  readonly generation: string
}
type SettledSelection =
  | AdoptedSelection
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

function resolvedScanId(resolution: SnapshotSelectionResolution): string | null {
  return resolution.mode === 'explicit'
    ? resolution.metadata.id
    : (resolution.availability.snapshot?.entries.scanId ?? null)
}

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
    selection: SnapshotSelection,
    keepCurrent = false
  ): Promise<SettledSelection | undefined> {
    const previous = this.get(view)
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
      if (
        resolution.mode !== selection.mode ||
        (selection.mode === 'explicit' &&
          resolution.mode === 'explicit' &&
          selection.scanId !== resolution.metadata.id)
      )
        return fail(selectionError('INTERNAL_ERROR', 'Storage resolved a different selection.'))
      const adopted = await this.api.adoptSnapshotSelection({
        view,
        ticket,
        ...(keepCurrent ? { keepCurrent: true } : {})
      })
      if (!current()) return undefined
      if (!adopted.ok) return fail(adopted.error)
      const scanId = resolvedScanId(resolution)
      const generation =
        keepCurrent &&
        previous?.status === 'resolved' &&
        scanId === resolvedScanId(previous.resolution)
          ? previous.generation
          : ticket
      const outcome = {
        status:
          resolution.mode === 'follow-latest' && !resolution.availability.snapshot
            ? 'empty'
            : 'resolved',
        selection,
        resolution,
        explorerSnapshot: adopted.value,
        latestVersion,
        generation
      } as const
      this.views.set(view, outcome)
      return outcome
    } catch {
      if (!current()) return undefined
      return fail(selectionError('UNAVAILABLE', 'The snapshot selection could not be loaded.'))
    }
  }

  async loadExplorer(
    selection: SnapshotSelection,
    current: () => boolean,
    handoff?: ViewSnapshotOptions['handoff']
  ): Promise<ScannerIpcResult<ScanSnapshotAvailability>> {
    const result = await this.resolve('explorer', selection, current, handoff)
    if (!result.ok) return result
    const { resolution, explorerSnapshot } = result.value
    if (resolution.mode === 'follow-latest') return { ok: true, value: resolution.availability }
    if (explorerSnapshot?.entries.scanId === resolution.metadata.id)
      return { ok: true, value: { snapshot: explorerSnapshot, unavailable: null } }
    return {
      ok: false,
      error: selectionError(
        'SNAPSHOT_UNAVAILABLE',
        'The saved snapshot has no validated Explorer root.'
      )
    }
  }

  async loadInsights(
    selection: SnapshotSelection,
    current: () => boolean,
    handoff: ViewSnapshotOptions['handoff'],
    keepCurrent: boolean
  ): Promise<
    ScannerIpcResult<{
      scanId: string | null
      unavailable: ScanSnapshotAvailability['unavailable']
      generation: string
    }>
  > {
    const result = await this.resolve('insights', selection, current, handoff, keepCurrent)
    if (!result.ok) return result
    const { resolution, generation } = result.value
    return {
      ok: true,
      value: {
        scanId: resolvedScanId(resolution),
        unavailable: resolution.mode === 'explicit' ? null : resolution.availability.unavailable,
        generation
      }
    }
  }

  private async resolve(
    view: SnapshotView,
    selection: SnapshotSelection,
    current: () => boolean,
    handoff?: ViewSnapshotOptions['handoff'],
    keepCurrent = false
  ): Promise<ScannerIpcResult<AdoptedSelection>> {
    const prepared = handoff && (await handoff)
    if (!current())
      return { ok: false, error: selectionError('UNAVAILABLE', 'The snapshot selection changed.') }
    const outcome =
      prepared && prepared === this.get(view) && this.usableHandoff(prepared)
        ? prepared
        : await this.select(view, selection, keepCurrent)
    if (!outcome || !current())
      return { ok: false, error: selectionError('UNAVAILABLE', 'The snapshot selection changed.') }
    if ('error' in outcome) return { ok: false, error: outcome.error }
    return { ok: true, value: outcome }
  }

  isHistoricalSelection(view: SnapshotView): boolean {
    const state = this.get(view)
    if (state?.status !== 'resolved' || state.resolution.mode !== 'explicit') return false
    const { metadata } = state.resolution
    return this.latestVersion === state.latestVersion
      ? !metadata.isLatest
      : this.latestCompleted?.id !== metadata.id
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
