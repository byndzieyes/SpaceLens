import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScanHistoryErrorCode } from '../../../../shared/history'
import type { StorageTrends, TrendSelection } from '../../../../shared/trends'

type TrendsError = ScanHistoryErrorCode | 'HISTORY_CHANGED'
type TrendsState =
  | { status: 'loading'; data?: StorageTrends }
  | { status: 'ready'; data: StorageTrends }
  | { status: 'error'; code: TrendsError; data?: StorageTrends }

export function useStorageTrends(
  active: boolean,
  historyRevision: number
): {
  state: TrendsState
  anchor: string | undefined
  select: (scanId: string, rootPath: string) => void
  retry: () => void
} {
  const [choice, setChoice] = useState<{ selection: TrendSelection; anchor?: string }>({
    selection: { mode: 'latest' }
  })
  const [attempt, setAttempt] = useState(0)
  const request = useMemo(
    () => ({ active, choice, historyRevision, attempt }),
    [active, choice, historyRevision, attempt]
  )
  const [settled, setSettled] = useState<{ request: typeof request; state: TrendsState }>()
  const lastSeries = useRef<{ choice: typeof choice; data: StorageTrends }>(undefined)

  useEffect(() => {
    if (!request.active) return
    let current = true
    const previous =
      lastSeries.current?.choice === request.choice ? lastSeries.current.data : undefined
    // Once resolved, keep the canonical series identity even if its anchor is later pruned.
    const selection = previous?.series
      ? { mode: 'series' as const, series: previous.series }
      : request.choice.selection
    const fail = (code: TrendsError): void => {
      if (current) setSettled({ request, state: { status: 'error', code, data: previous } })
    }
    const load = async (): Promise<void> => {
      if (!current) return
      try {
        const response = await window.spaceLens.getStorageTrends(selection)
        if (!current) return
        if (!response.ok) {
          fail(response.error.code)
          return
        }
        lastSeries.current = { choice: request.choice, data: response.value }
        setSettled({ request, state: { status: 'ready', data: response.value } })
      } catch {
        fail('UNAVAILABLE')
      }
    }
    queueMicrotask(() => void load())
    return () => {
      current = false
    }
  }, [request])

  return {
    state:
      settled?.request === request
        ? settled.state
        : {
            status: 'loading',
            data: settled?.request.choice === choice ? settled.state.data : undefined
          },
    anchor: choice.anchor,
    select: (scanId, rootPath) =>
      setChoice({ selection: { mode: 'snapshot', scanId }, anchor: rootPath }),
    retry: () => setAttempt((value) => value + 1)
  }
}
