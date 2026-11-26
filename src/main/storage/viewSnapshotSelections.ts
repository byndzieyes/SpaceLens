import { randomUUID } from 'node:crypto'
import type { ScanHistoryItem } from '../../shared/history'
import type {
  PreparedSnapshotSelection,
  SnapshotSelectionAdoption,
  SnapshotSelectionAdoptionResult,
  SnapshotSelectionRequest,
  SnapshotSelectionResolution,
  SnapshotView
} from '../../shared/snapshotSelection'
import type { ScanSnapshot } from '../../shared/snapshot'
import { ComparisonSelection, type ComparisonStorage } from './comparisonSelection'
import { StorageUnavailableError, type ScanStorageCoordinator } from './coordinator'
import { isSnapshotId, record } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'
import type { SnapshotProtectionOwner } from './snapshotProtection'
import { STORAGE_REQUEST_TIMEOUT_MS } from './workerClient'

interface PendingSelection {
  readonly ticket: string
  readonly abort: AbortController
  scanId?: string
  explorerSnapshot?: ScanSnapshot
  expiry?: ReturnType<typeof setTimeout>
}

interface ViewSelection {
  readonly owner: SnapshotProtectionOwner<ScanHistoryItem>
  adopted?: { readonly scanId: string }
  pending?: PendingSelection
}

const inactive = (): StorageUnavailableError =>
  new StorageUnavailableError('The snapshot selection is no longer active.')

function hasFields(value: unknown, ...fields: string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key))
  )
}

const validView = (view: unknown): view is SnapshotView =>
  view === 'explorer' || view === 'insights'

function invalidRequest(): never {
  throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid snapshot selection request.')
}

export function readSelectionRequest(value: unknown): SnapshotSelectionRequest {
  if (!hasFields(value, 'view', 'selection') || !validView(value.view)) return invalidRequest()
  const { view, selection } = value
  if (hasFields(selection, 'mode') && selection.mode === 'follow-latest')
    return { view, selection: { mode: 'follow-latest' } }
  if (
    hasFields(selection, 'mode', 'scanId') &&
    selection.mode === 'explicit' &&
    isSnapshotId(selection.scanId)
  )
    return { view, selection: { mode: 'explicit', scanId: selection.scanId } }
  return invalidRequest()
}

export function readSelectionAdoption(value: unknown): SnapshotSelectionAdoption {
  const refresh =
    hasFields(value, 'view', 'ticket', 'keepCurrent') &&
    value.view === 'insights' &&
    value.keepCurrent === true
  if (
    (!refresh && !hasFields(value, 'view', 'ticket')) ||
    !record(value) ||
    !validView(value.view) ||
    typeof value.ticket !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.ticket)
  )
    return invalidRequest()
  return { view: value.view, ticket: value.ticket, ...(refresh ? { keepCurrent: true } : {}) }
}

export function readSelectionView(value: unknown): SnapshotView {
  if (!hasFields(value, 'view') || !validView(value.view)) return invalidRequest()
  return value.view
}

/** One owner per supported view and one provisional replacement per owner. */
export class ViewSnapshotSelections {
  readonly comparison: ComparisonSelection
  private readonly views = new Map<SnapshotView, ViewSelection>()

  constructor(
    private readonly storage: Pick<ScanStorageCoordinator, 'read' | 'createSnapshotOwner'> &
      ComparisonStorage,
    private readonly document: AbortSignal
  ) {
    this.comparison = new ComparisonSelection(storage, document)
    document.addEventListener(
      'abort',
      () => {
        for (const view of this.views.keys()) this.release(view)
      },
      { once: true }
    )
  }

  async prepare(
    { view, selection }: SnapshotSelectionRequest,
    authorized: () => boolean
  ): Promise<PreparedSnapshotSelection> {
    if (this.document.aborted || !authorized()) throw inactive()
    let slot = this.views.get(view)
    if (!slot) {
      slot = { owner: this.storage.createSnapshotOwner(this.document) }
      this.views.set(view, slot)
    }
    this.cancelPending(slot)
    const pending: PendingSelection = { ticket: randomUUID(), abort: new AbortController() }
    slot.pending = pending
    const requireCurrent = (): void => {
      if (slot.pending !== pending || !authorized()) throw inactive()
    }
    const acquire = (scanId: string): Promise<ScanHistoryItem> => {
      requireCurrent()
      pending.scanId = scanId
      return slot.owner.acquire(scanId, pending.abort.signal)
    }

    try {
      let resolution: SnapshotSelectionResolution
      const signal = AbortSignal.any([this.document, pending.abort.signal])
      if (selection.mode === 'explicit') {
        const { scanId } = selection
        const metadata = await acquire(scanId)
        requireCurrent()
        const snapshot = await this.storage.read(
          signal,
          (client) => client.openSavedSnapshot(scanId),
          scanId
        )
        if (snapshot.entries.scanId !== scanId)
          throw new Error('Storage returned a different saved snapshot.')
        if (view === 'explorer') pending.explorerSnapshot = snapshot
        resolution = { mode: 'explicit', metadata }
      } else {
        const discover = async (): Promise<SnapshotSelectionResolution> => {
          const availability = await this.storage.read(signal, (client) => client.getScanSnapshot())
          requireCurrent()
          if (availability.snapshot) {
            const scanId = availability.snapshot.entries.scanId
            const metadata = await acquire(scanId)
            // A queued publication can run between discovery and validation.
            if (scanId !== slot.adopted?.scanId && !metadata.isLatest)
              throw new SnapshotAccessError('SNAPSHOT_EXPIRED', 'The latest saved scan changed.')
          }
          return { mode: 'follow-latest', availability }
        }
        try {
          resolution = await discover()
        } catch (error) {
          if (
            !(error instanceof SnapshotAccessError) ||
            (error.code !== 'SNAPSHOT_IN_USE' && error.code !== 'SNAPSHOT_EXPIRED')
          )
            throw error
          // The next read observes a queued deletion or publication before resolving Latest again.
          requireCurrent()
          if (pending.scanId !== undefined && pending.scanId !== slot.adopted?.scanId)
            slot.owner.release(pending.scanId)
          pending.scanId = undefined
          resolution = await discover()
        }
      }
      requireCurrent()
      pending.expiry = setTimeout(
        () => this.discard(view, slot, pending),
        STORAGE_REQUEST_TIMEOUT_MS
      )
      return { ticket: pending.ticket, resolution }
    } catch (error) {
      this.discard(view, slot, pending)
      throw error
    }
  }

  adopt({ view, ticket, keepCurrent }: SnapshotSelectionAdoption): SnapshotSelectionAdoptionResult {
    const slot = this.views.get(view)
    const pending = slot?.pending
    if (!slot || !pending?.expiry || pending.ticket !== ticket) throw inactive()
    const previous = slot.adopted?.scanId
    if (pending.scanId !== previous || (view === 'insights' && !keepCurrent))
      slot.adopted = pending.scanId === undefined ? undefined : { scanId: pending.scanId }
    this.cancelPending(slot)
    if (previous !== undefined && previous !== slot.adopted?.scanId) slot.owner.release(previous)
    if (!slot.adopted) this.release(view)
    return pending.explorerSnapshot ?? null
  }

  discardPrepared({ view, ticket }: SnapshotSelectionAdoption): void {
    const slot = this.views.get(view)
    if (slot?.pending?.ticket === ticket) this.discard(view, slot, slot.pending)
  }

  /** Use the adoption identity to reject replies from a previous selection or visit. */
  authorizeRead(view: SnapshotView, scanId: string): () => boolean {
    const adopted = this.views.get(view)?.adopted
    const title = view === 'explorer' ? 'Explorer' : 'Insights'
    if (!adopted)
      throw new SnapshotAccessError(
        'SNAPSHOT_UNAVAILABLE',
        `Open a saved snapshot in ${title} first.`
      )
    if (adopted.scanId !== scanId)
      throw new SnapshotAccessError('SNAPSHOT_EXPIRED', `${title} is using a different snapshot.`)
    return () => this.views.get(view)?.adopted === adopted
  }

  release(view: SnapshotView): void {
    const slot = this.views.get(view)
    if (!slot) return
    this.views.delete(view)
    this.cancelPending(slot)
    slot.owner.dispose()
  }

  private discard(view: SnapshotView, slot: ViewSelection, pending: PendingSelection): void {
    if (slot.pending !== pending) return
    this.cancelPending(slot)
    if (!slot.adopted) this.release(view)
  }

  private cancelPending(slot: ViewSelection): void {
    const { pending } = slot
    if (!pending) return
    slot.pending = undefined
    clearTimeout(pending.expiry)
    pending.abort.abort()
    if (pending.scanId !== undefined && pending.scanId !== slot.adopted?.scanId)
      slot.owner.release(pending.scanId)
  }
}
