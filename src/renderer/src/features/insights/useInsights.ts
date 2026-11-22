import { useCallback, useEffect, useRef, useState } from 'react'
import type { InsightsSummary } from '../../../../shared/insights'
import type { ScanStateSnapshot, ScannerIpcErrorCode } from '../../../../shared/ipc'

type ReadFailure = { code: ScannerIpcErrorCode; message: string }
type ExpiredReference =
  | { scanId: string; source: 'summary'; error: ReadFailure }
  | { scanId: string; source: 'categories' }
type InsightsState =
  | { status: 'loading'; refreshing: boolean; categoryScanId?: string }
  | { status: 'no-snapshot' }
  | { status: 'ready'; summary: InsightsSummary }
  | { status: 'error'; reason: 'expired' | 'unavailable' | 'read'; categoryScanId?: string }

const initialState: InsightsState = { status: 'loading', refreshing: false }

export function useInsights(): {
  state: InsightsState
  retry: () => void
  recheckPublication: (scanId: string) => Promise<void>
} {
  const [state, setState] = useState<InsightsState>(initialState)
  const retry = useRef<(() => void) | null>(null)
  const recheck = useRef<((scanId: string) => Promise<void>) | null>(null)
  const recheckPublication = useCallback(async (scanId: string) => {
    await recheck.current?.(scanId)
  }, [])

  useEffect(() => {
    const api = window.spaceLens
    let active = true
    let revision = -1
    let announcedScanId: string | undefined
    let resolvedScanId: string | undefined
    let request: { scanId?: string; visibleScanId?: string } | undefined
    let started = false

    const load = async (
      refreshing: boolean,
      expired?: ExpiredReference,
      retainedScanId?: string
    ): Promise<void> => {
      // A category failure stays local unless the read confirms a publication change.
      const verifyingCategory = expired?.source === 'categories'
      const pending: NonNullable<typeof request> = {
        visibleScanId: verifyingCategory ? resolvedScanId : retainedScanId
      }
      const announcedAtStart = announcedScanId
      started = true
      request = pending
      const clearSummary = (categoryScanId?: string): void => {
        resolvedScanId = undefined
        setState({ status: 'loading', refreshing, categoryScanId })
      }
      if (!verifyingCategory) clearSummary(retainedScanId)

      const isCurrent = (): boolean => active && request === pending
      const fail = (detail: unknown, code?: ScannerIpcErrorCode): void => {
        if (!isCurrent()) return
        if (import.meta.env.DEV)
          console.warn('Could not load Insights for the published scan.', detail)
        if (verifyingCategory && resolvedScanId !== undefined) return
        const reason =
          code === 'SNAPSHOT_EXPIRED'
            ? 'expired'
            : code === 'SNAPSHOT_UNAVAILABLE'
              ? 'unavailable'
              : 'read'
        resolvedScanId = reason === 'read' ? (pending.scanId ?? pending.visibleScanId) : undefined
        setState({ status: 'error', reason, categoryScanId: resolvedScanId })
      }

      try {
        const result = await api.getScanSnapshot()
        if (!isCurrent()) return
        const scanId = result.ok ? result.value.snapshot?.entries.scanId : undefined
        // A publication can be announced while the metadata read is returning an older snapshot.
        if (announcedScanId !== announcedAtStart && scanId !== announcedScanId) {
          void load(true, expired, pending.visibleScanId)
          return
        }
        if (!result.ok) {
          fail(result.error, result.error.code)
          return
        }
        if (!scanId) {
          const { unavailable } = result.value
          if (unavailable) fail(unavailable, 'SNAPSHOT_UNAVAILABLE')
          else {
            resolvedScanId = undefined
            setState({ status: 'no-snapshot' })
          }
          return
        }
        if (expired?.scanId === scanId) {
          if (expired.source === 'summary') fail(expired.error, expired.error.code)
          else if (!pending.visibleScanId) fail({ scanId, announcedScanId }, 'SNAPSHOT_EXPIRED')
          return
        }

        if (pending.visibleScanId && pending.visibleScanId !== scanId) clearSummary()
        pending.scanId = scanId
        const resultSummary = await api.getInsightsSummary({ scanId })
        if (!isCurrent()) return
        if (!resultSummary.ok) {
          const { error } = resultSummary
          // The worker may see the replacement before its notification reaches the renderer.
          if (error.code === 'SNAPSHOT_EXPIRED' && expired?.source !== 'summary') {
            void load(true, { scanId, error, source: 'summary' })
          } else fail(error, error.code)
          return
        }
        if (resultSummary.value.scanId !== scanId) {
          fail({ expectedScanId: scanId, receivedScanId: resultSummary.value.scanId })
          return
        }
        resolvedScanId = scanId
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
        published === resolvedScanId ||
        published === request?.scanId ||
        published === request?.visibleScanId
      ) {
        return
      }
      if (request && !request.scanId) {
        // Keep the pending metadata read, but retire the old view as soon as Main announces a replacement.
        if (request.visibleScanId) {
          request.visibleScanId = undefined
          resolvedScanId = undefined
          setState({ status: 'loading', refreshing: true })
        }
        return
      }
      void load(resolvedScanId !== undefined || request !== undefined)
    })

    retry.current = () => {
      if (active && !request) void load(false, undefined, resolvedScanId)
    }
    recheck.current = async (scanId) => {
      if (active && !request && resolvedScanId === scanId) {
        await load(true, { scanId, source: 'categories' })
      }
    }
    // Skip requests from a mount that Strict Mode or page navigation has already discarded.
    queueMicrotask(() => {
      if (active && !started) void load(false)
    })
    return () => {
      active = false
      retry.current = null
      recheck.current = null
      unsubscribe()
    }
  }, [])

  return { state, retry: () => retry.current?.(), recheckPublication }
}
