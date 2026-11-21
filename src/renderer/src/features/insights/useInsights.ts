import { useEffect, useRef, useState } from 'react'
import type { InsightsSummary } from '../../../../shared/insights'
import type { ScanStateSnapshot, ScannerIpcErrorCode } from '../../../../shared/ipc'

type ReadFailure = { code: ScannerIpcErrorCode; message: string }
type InsightsState =
  | { status: 'loading'; refreshing: boolean }
  | { status: 'no-snapshot' }
  | { status: 'ready'; summary: InsightsSummary }
  | { status: 'error'; reason: 'expired' | 'unavailable' | 'read' }

const initialState: InsightsState = { status: 'loading', refreshing: false }

export function useInsights(): { state: InsightsState; retry: () => void } {
  const [state, setState] = useState<InsightsState>(initialState)
  const retry = useRef<(() => void) | null>(null)

  useEffect(() => {
    const api = window.spaceLens
    let active = true
    let revision = -1
    let announcedScanId: string | undefined
    let displayedScanId: string | undefined
    let request: { scanId?: string } | undefined
    let started = false

    const load = async (
      refreshing: boolean,
      expired?: { scanId: string; error: ReadFailure }
    ): Promise<void> => {
      const pending: { scanId?: string } = {}
      const announcedAtStart = announcedScanId
      started = true
      request = pending
      displayedScanId = undefined
      setState({ status: 'loading', refreshing })

      const isCurrent = (): boolean => active && request === pending
      const fail = (detail: unknown, code?: ScannerIpcErrorCode): void => {
        if (!isCurrent()) return
        if (import.meta.env.DEV)
          console.warn('Could not load Insights for the published scan.', detail)
        setState({
          status: 'error',
          reason:
            code === 'SNAPSHOT_EXPIRED'
              ? 'expired'
              : code === 'SNAPSHOT_UNAVAILABLE'
                ? 'unavailable'
                : 'read'
        })
      }

      try {
        const result = await api.getScanSnapshot()
        if (!isCurrent()) return
        const scanId = result.ok ? result.value.snapshot?.entries.scanId : undefined
        // A publication can be announced while the metadata read is returning an older snapshot.
        if (announcedScanId !== announcedAtStart && scanId !== announcedScanId) {
          void load(refreshing, expired)
          return
        }
        if (!result.ok) {
          fail(result.error, result.error.code)
          return
        }
        if (!scanId) {
          const { unavailable } = result.value
          if (unavailable) fail(unavailable, 'SNAPSHOT_UNAVAILABLE')
          else setState({ status: 'no-snapshot' })
          return
        }
        if (expired?.scanId === scanId) {
          fail(expired.error, expired.error.code)
          return
        }

        pending.scanId = scanId
        const resultSummary = await api.getInsightsSummary({ scanId })
        if (!isCurrent()) return
        if (!resultSummary.ok) {
          const { error } = resultSummary
          // The worker may see the replacement before its notification reaches the renderer.
          if (error.code === 'SNAPSHOT_EXPIRED' && !expired) void load(true, { scanId, error })
          else fail(error, error.code)
          return
        }
        if (resultSummary.value.scanId !== scanId) {
          fail({ expectedScanId: scanId, receivedScanId: resultSummary.value.scanId })
          return
        }
        displayedScanId = scanId
        setState({ status: 'ready', summary: resultSummary.value })
      } catch (error) {
        fail(error)
      } finally {
        if (isCurrent()) request = undefined
      }
    }

    const unsubscribe = api.onScanStateChanged((update: ScanStateSnapshot) => {
      if (!active || update.revision <= revision) return
      revision = update.revision
      const published = update.latestCompleted?.id
      if (!published || published === announcedScanId) return
      announcedScanId = published
      if (
        published === displayedScanId ||
        (request && (!request.scanId || published === request.scanId))
      ) {
        return
      }
      void load(displayedScanId !== undefined || request !== undefined)
    })

    retry.current = () => {
      if (active && !request) void load(false)
    }
    // Skip requests from a mount that Strict Mode or page navigation has already discarded.
    queueMicrotask(() => {
      if (active && !started) void load(false)
    })
    return () => {
      active = false
      retry.current = null
      unsubscribe()
    }
  }, [])

  return { state, retry: () => retry.current?.() }
}
