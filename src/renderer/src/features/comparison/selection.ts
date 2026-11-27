import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type {
  AdoptedComparisonSelection,
  ComparisonErrorCode,
  ComparisonPair,
  ComparisonSide
} from '../../../../shared/comparison'
import type { ScanHistoryItem } from '../../../../shared/history'
import type { ComparisonAPI } from '../../../../shared/ipc'

export interface ActiveComparison {
  readonly selection: AdoptedComparisonSelection
  readonly snapshots: Readonly<Record<ComparisonSide, ScanHistoryItem>>
}

export interface ComparisonSelectionFailure {
  readonly operation: 'prepare' | 'adopt' | 'release'
  readonly code: ComparisonErrorCode
}

// The Main slot is document-wide. Serialize adoption and release across visits so
// a release always uses the identity known after any already-dispatched adoption.
export class ComparisonMutations {
  private pending?: Promise<void>

  constructor(readonly api: ComparisonAPI = window.spaceLens) {}

  wait(): Promise<void> | undefined {
    return this.pending
  }

  run(operation: () => Promise<void>): Promise<void> {
    const next = (this.pending ?? Promise.resolve()).then(operation)
    const settled = next.catch(() => {})
    this.pending = settled
    void settled.then(() => {
      if (this.pending === settled) this.pending = undefined
    })
    return next
  }
}

interface Attempt {
  phase: 'preparing' | 'adopting'
}

function samePair(left: ComparisonPair, right: ComparisonPair): boolean {
  return left.baselineScanId === right.baselineScanId && left.targetScanId === right.targetScanId
}

export function useComparisonSelection(mutations: ComparisonMutations): {
  active: ActiveComparison | undefined
  pending: Attempt['phase'] | undefined
  failure: ComparisonSelectionFailure | undefined
  start: (pair: ComparisonPair, snapshots: ActiveComparison['snapshots']) => void
  changeDraft: () => boolean
  clear: () => void
} {
  const [active, setActive] = useState<ActiveComparison>()
  const [pending, setPending] = useState<Attempt['phase']>()
  const [failure, setFailure] = useState<ComparisonSelectionFailure>()
  const mounted = useRef(false)
  const attempt = useRef<Attempt>(undefined)
  const ownsSlot = useRef(false)
  const selectionId = useRef<string | null>(null)

  const release = useCallback((): void => {
    attempt.current = undefined
    if (!ownsSlot.current) return
    ownsSlot.current = false
    void mutations.run(async () => {
      const id = selectionId.current
      try {
        const result = await mutations.api.releaseComparisonSelection({ selectionId: id })
        if (!result.ok && mounted.current && !attempt.current)
          setFailure({ operation: 'release', code: result.error.code })
      } catch {
        if (mounted.current && !attempt.current)
          setFailure({ operation: 'release', code: 'UNAVAILABLE' })
      } finally {
        selectionId.current = null
      }
    })
  }, [mutations])

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      release()
    }
  }, [release])

  const start = async (
    pair: ComparisonPair,
    snapshots: ActiveComparison['snapshots']
  ): Promise<void> => {
    if (attempt.current) return
    const request: Attempt = { phase: 'preparing' }
    attempt.current = request
    setPending(request.phase)
    setFailure(undefined)
    const current = (): boolean => attempt.current === request
    const fail = (code: ComparisonErrorCode): void => {
      if (current())
        setFailure({ operation: request.phase === 'preparing' ? 'prepare' : 'adopt', code })
    }
    let ticket: string | undefined
    const discard = async (): Promise<void> => {
      if (!ticket) return
      try {
        await mutations.api.discardPreparedComparisonSelection({ ticket })
      } catch {
        // Main also expires unclaimed tickets and discards them on document invalidation.
      }
    }
    try {
      const barrier = mutations.wait()
      if (barrier) await barrier
      if (!current()) return
      ownsSlot.current = true
      const prepared = await mutations.api.prepareComparisonSelection(pair)
      if (!prepared.ok) {
        fail(prepared.error.code)
        return
      }
      ticket = prepared.value.ticket
      if (!current()) return
      if (!samePair(pair, prepared.value.compatibility.pair)) {
        fail('INTERNAL_ERROR')
        return
      }

      await mutations.run(async () => {
        if (!current()) return
        request.phase = 'adopting'
        setPending(request.phase)
        const adopted = await mutations.api.adoptComparisonSelection({
          ticket: prepared.value.ticket
        })
        if (!adopted.ok) {
          fail(adopted.error.code)
          return
        }
        // If the view closed during adoption, its queued release reads this exact ID.
        selectionId.current = adopted.value.selectionId
        ticket = undefined
        if (current()) setActive({ selection: adopted.value, snapshots })
      })
    } catch {
      fail('UNAVAILABLE')
    } finally {
      if (ticket) await discard()
      if (current()) {
        attempt.current = undefined
        setPending(undefined)
      }
    }
  }

  return {
    active,
    pending,
    failure,
    start: (pair, snapshots) => void start(pair, snapshots),
    changeDraft: () => {
      // An adoption request already sent to Main can replace the old pair atomically.
      if (attempt.current?.phase === 'adopting') return false
      attempt.current = undefined
      setFailure(undefined)
      setPending(undefined)
      return true
    },
    clear: () => {
      setActive(undefined)
      setFailure(undefined)
      setPending(undefined)
      release()
    }
  }
}
