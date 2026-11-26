import { randomUUID } from 'node:crypto'
import type {
  AdoptedComparisonSelection,
  ComparisonCompatibility,
  ComparisonPair,
  PreparedComparisonSelection
} from '../../shared/comparison'
import {
  comparisonMetadataForStoredScan,
  evaluateComparisonCompatibility
} from '../comparison/compatibility'
import { isComparisonPathKey } from '../comparison/paths'
import { ComparisonStorageError } from './comparisonMatchContracts'
import {
  type ComparisonQueries,
  type ScanStorageCoordinator,
  StorageUnavailableError
} from './coordinator'
import { SnapshotAccessError } from './snapshotAccess'
import { STORAGE_REQUEST_TIMEOUT_MS } from './workerClient'

export type ComparisonStorage = Pick<
  ScanStorageCoordinator,
  'readPair' | 'protectComparisonPair' | 'readSignal'
>

interface PendingPair {
  readonly ticket: string
  readonly abort: AbortController
  readonly release: () => void
  prepared?: PreparedComparisonSelection
  expiry?: ReturnType<typeof setTimeout>
}

interface AdoptedPair {
  readonly selection: AdoptedComparisonSelection
  readonly abort: AbortController
  readonly release: () => void
}

interface SelectionReply<Value> {
  readonly value: Value
  verify(): void
}

const inactive = (): StorageUnavailableError =>
  new StorageUnavailableError('The comparison selection is no longer active.')
const obsolete = (): SnapshotAccessError =>
  new SnapshotAccessError('SNAPSHOT_EXPIRED', 'The comparison selection changed.')

/** One provisional owner and one adopted owner, scoped to a renderer document and Worker. */
export class ComparisonSelection {
  private readonly lifetime: AbortSignal
  private pending?: PendingPair
  private adopted?: AdoptedPair

  constructor(
    private readonly storage: ComparisonStorage,
    document: AbortSignal
  ) {
    this.lifetime = AbortSignal.any([document, storage.readSignal])
    this.lifetime.addEventListener(
      'abort',
      () => this.release(this.adopted?.selection.selectionId ?? null),
      { once: true }
    )
  }

  evaluate(pair: ComparisonPair, signal = this.lifetime): Promise<ComparisonCompatibility> {
    if (signal.aborted) throw inactive()
    if (pair.baselineScanId === pair.targetScanId)
      return Promise.resolve(evaluateComparisonCompatibility(pair, null, null))

    return this.storage.readPair(
      signal,
      async (client) => {
        const baseline = await client.getScan(pair.baselineScanId)
        if (signal.aborted) throw inactive()
        const target = await client.getScan(pair.targetScanId)
        return evaluateComparisonCompatibility(
          pair,
          baseline && comparisonMetadataForStoredScan(baseline),
          target && comparisonMetadataForStoredScan(target)
        )
      },
      pair
    )
  }

  async prepare(pair: ComparisonPair): Promise<SelectionReply<PreparedComparisonSelection>> {
    if (this.lifetime.aborted) throw inactive()
    this.discardPending()
    if (pair.baselineScanId === pair.targetScanId)
      throw new ComparisonStorageError('INCOMPATIBLE_SNAPSHOTS', 'Choose two different scans.')

    const pending: PendingPair = {
      ticket: randomUUID(),
      abort: new AbortController(),
      release: this.storage.protectComparisonPair(this.lifetime, pair)
    }
    this.pending = pending
    const signal = AbortSignal.any([this.lifetime, pending.abort.signal])
    try {
      const compatibility = await this.evaluate(pair, signal)
      if (compatibility.status === 'incompatible') {
        const { reason } = compatibility
        if (reason.code === 'SNAPSHOT_EXPIRED' || reason.code === 'SNAPSHOT_UNAVAILABLE')
          throw new SnapshotAccessError(reason.code, 'A comparison snapshot is unavailable.')
        throw new ComparisonStorageError('INCOMPATIBLE_SNAPSHOTS', 'These scans are incompatible.')
      }
      for (const scanId of [pair.baselineScanId, pair.targetScanId]) {
        // Separate admissions allow scanner writes between historical validations.
        const scan = await this.storage.readPair(
          signal,
          (client) => client.requireValidatedScan(scanId),
          pair
        )
        if (scan.id !== scanId) throw new Error('Storage returned a different comparison snapshot.')
      }
      if (signal.aborted) throw inactive()
      const prepared = { ticket: pending.ticket, compatibility }
      pending.prepared = prepared
      pending.expiry = setTimeout(() => this.discard(pending.ticket), STORAGE_REQUEST_TIMEOUT_MS)
      return {
        value: prepared,
        verify: () => {
          if (signal.aborted) throw inactive()
        }
      }
    } catch (error) {
      this.discard(pending.ticket)
      throw error
    }
  }

  adopt(ticket: string): SelectionReply<AdoptedComparisonSelection> {
    const pending = this.pending
    if (this.lifetime.aborted) throw inactive()
    if (pending?.ticket !== ticket || !pending.prepared) throw obsolete()
    const previous = this.adopted
    const selection = { selectionId: randomUUID(), compatibility: pending.prepared.compatibility }
    const adopted = { selection, abort: new AbortController(), release: pending.release }
    this.adopted = adopted
    this.pending = undefined
    clearTimeout(pending.expiry)
    previous?.abort.abort()
    previous?.release()
    return { value: selection, verify: () => this.verifyAdoption(adopted) }
  }

  discard(ticket: string): void {
    if (this.pending?.ticket === ticket) this.discardPending()
  }

  release(selectionId: string | null): void {
    const adopted = this.adopted
    if (selectionId !== (adopted?.selection.selectionId ?? null)) return
    this.adopted = undefined
    this.discardPending()
    adopted?.abort.abort()
    adopted?.release()
  }

  async read<T>(
    selectionId: string,
    pair: ComparisonPair & { readonly relativeDirectory?: string },
    query: (client: ComparisonQueries) => Promise<T>
  ): Promise<SelectionReply<T>> {
    if (this.lifetime.aborted) throw inactive()
    const adopted = this.adopted
    if (!adopted) throw new SnapshotAccessError('SNAPSHOT_UNAVAILABLE', 'Adopt a comparison first.')
    const { compatibility } = adopted.selection
    if (
      selectionId !== adopted.selection.selectionId ||
      pair.baselineScanId !== compatibility.pair.baselineScanId ||
      pair.targetScanId !== compatibility.pair.targetScanId
    )
      throw obsolete()
    if (
      pair.relativeDirectory !== undefined &&
      !isComparisonPathKey(pair.relativeDirectory, compatibility.pathStyle)
    )
      throw new SnapshotAccessError('INVALID_REQUEST', 'The comparison path is invalid.')
    const signal = AbortSignal.any([this.lifetime, adopted.abort.signal])
    const verify = (): void => this.verifyAdoption(adopted)
    try {
      const value = await this.storage.readPair<T>(signal, query, pair)
      return { value, verify }
    } catch (error) {
      verify()
      throw error
    }
  }

  private verifyAdoption(adopted: AdoptedPair): void {
    if (this.lifetime.aborted) throw inactive()
    if (this.adopted !== adopted) throw obsolete()
  }

  private discardPending(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.expiry)
    pending.abort.abort()
    pending.release()
  }
}
