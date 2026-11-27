import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type {
  AdoptedComparisonSelection,
  ComparisonErrorCode,
  ComparisonSummary
} from '../../../../shared/comparison'

type SummaryState =
  | { status: 'loading' }
  | { status: 'ready'; summary: ComparisonSummary }
  | { status: 'error'; code: ComparisonErrorCode }

/** Mount once per adoption ID. A draft edit or a scanner update does not replace this read. */
export function useComparisonSummary(
  { selectionId, compatibility: { pair } }: AdoptedComparisonSelection,
  scanActive: boolean | undefined
): { state: SummaryState; retry: () => void } {
  const [result, setResult] = useState<{ selectionId: string; state: SummaryState }>()
  const readScannerState = useEffectEvent(() => scanActive === true)
  const retryRead = useRef<(scanActive: boolean) => Promise<void>>(null)
  const { baselineScanId, targetScanId } = pair

  useEffect(() => {
    let active = true
    let pending = false
    const update = (state: SummaryState): void => {
      if (active) setResult({ selectionId, state })
    }
    const load = async (blocked: boolean): Promise<void> => {
      if (!active || pending) return
      if (blocked) {
        update({ status: 'error', code: 'COMPARISON_SCAN_ACTIVE' })
        return
      }
      pending = true
      update({ status: 'loading' })
      try {
        const result = await window.spaceLens.getComparisonSummary({
          selectionId,
          query: { baselineScanId, targetScanId }
        })
        if (!active) return
        if (!result.ok) {
          update({ status: 'error', code: result.error.code })
          return
        }
        const { value } = result
        if (
          value.pair.baselineScanId !== baselineScanId ||
          value.pair.targetScanId !== targetScanId ||
          value.baseline.id !== baselineScanId ||
          value.target.id !== targetScanId
        ) {
          update({ status: 'error', code: 'INTERNAL_ERROR' })
          return
        }
        update({ status: 'ready', summary: value })
      } catch {
        update({ status: 'error', code: 'UNAVAILABLE' })
      } finally {
        pending = false
      }
    }
    retryRead.current = load
    // React can replay effects in development. Only dispatch for the live effect.
    queueMicrotask(() => {
      if (active) void load(readScannerState())
    })
    return () => {
      // Main still owns protection for requests already dispatched to storage.
      active = false
      retryRead.current = null
    }
  }, [baselineScanId, selectionId, targetScanId])

  const state = result?.selectionId === selectionId ? result.state : { status: 'loading' as const }
  return { state, retry: () => void retryRead.current?.(scanActive === true) }
}
