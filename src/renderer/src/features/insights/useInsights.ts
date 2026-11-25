import { useCallback, useEffect, useRef, useState } from 'react'
import type { InsightsSummary } from '../../../../shared/insights'
import type { ScanStateSnapshot, ScannerIpcErrorCode } from '../../../../shared/ipc'
import { followLatest } from '../../../../shared/snapshotSelection'
import { useSnapshotSelections, type ViewSnapshotOptions } from '../snapshots/selection'

type ReadFailure = { code: ScannerIpcErrorCode; message: string }
type ExpiredReference =
  | { scanId: string; source: 'summary'; error: ReadFailure }
  | { scanId: string; source: 'analytics' }
type InsightsState =
  | { status: 'loading'; refreshing: boolean; analyticsScanId?: string }
  | { status: 'no-snapshot' }
  | { status: 'ready'; summary: InsightsSummary }
  | { status: 'error'; reason: 'expired' | 'unavailable' | 'read'; analyticsScanId?: string }

const initialState: InsightsState = { status: 'loading', refreshing: false }

export function useInsights(snapshots?: ViewSnapshotOptions): {
  state: InsightsState
  retry: () => void
  recheckPublication: (scanId: string) => Promise<void>
} {
  const selections = useSnapshotSelections(snapshots?.controller)
  const selection = snapshots?.selection ?? followLatest
  const handoff = snapshots?.handoff
  const managed = snapshots !== undefined
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
    let announcedScanId: string | null | undefined
    let resolvedScanId: string | undefined
    let resolvedEmpty = false
    let request: { scanId?: string; visibleScanId?: string } | undefined
    let started = false

    const load = async (
      refreshing: boolean,
      expired?: ExpiredReference,
      retainedScanId?: string,
      initialHandoff?: ViewSnapshotOptions['handoff']
    ): Promise<void> => {
      // A section failure stays local unless the read confirms a publication change.
      const verifyingAnalytics = expired?.source === 'analytics'
      const pending: NonNullable<typeof request> = {
        visibleScanId: verifyingAnalytics ? resolvedScanId : retainedScanId
      }
      const announcedAtStart = announcedScanId
      started = true
      request = pending
      const clearSummary = (analyticsScanId?: string): void => {
        resolvedScanId = undefined
        resolvedEmpty = false
        setState({ status: 'loading', refreshing, analyticsScanId })
      }
      if (!verifyingAnalytics) clearSummary(retainedScanId)

      const isCurrent = (): boolean => active && request === pending
      const fail = (detail: unknown, code?: ScannerIpcErrorCode): void => {
        if (!isCurrent()) return
        if (import.meta.env.DEV)
          console.warn('Could not load Insights for the published scan.', detail)
        if (verifyingAnalytics && resolvedScanId !== undefined) return
        const reason =
          code === 'SNAPSHOT_EXPIRED'
            ? 'expired'
            : code === 'SNAPSHOT_UNAVAILABLE'
              ? 'unavailable'
              : 'read'
        resolvedScanId = reason === 'read' ? (pending.scanId ?? pending.visibleScanId) : undefined
        setState({ status: 'error', reason, analyticsScanId: resolvedScanId })
      }

      try {
        const result = await selections.loadForCurrentView(
          'insights',
          selection,
          isCurrent,
          initialHandoff
        )
        if (!isCurrent()) return
        const scanId = result.ok ? (result.value.snapshot?.entries.scanId ?? null) : undefined
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
            resolvedEmpty = true
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

    const unsubscribe = selections.subscribeScanState((update: ScanStateSnapshot) => {
      if (!active || selection.mode !== 'follow-latest' || update.revision <= revision) return
      revision = update.revision
      const published =
        update.latestCompleted?.id ??
        (update.latestCompleted === null && update.historyRevision !== undefined ? null : undefined)
      if (published === undefined || published === announcedScanId) return
      announcedScanId = published
      if (published === null) {
        if (resolvedEmpty || (request && !request.scanId && !request.visibleScanId)) return
        void load(resolvedScanId !== undefined || request !== undefined)
        return
      }
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
        await load(true, { scanId, source: 'analytics' })
      }
    }
    // Skip requests from a mount that Strict Mode or page navigation has already discarded.
    queueMicrotask(() => {
      if (active && !started) void load(false, undefined, undefined, handoff)
    })
    return () => {
      active = false
      retry.current = null
      recheck.current = null
      unsubscribe()
      if (!managed) selections.release('insights')
    }
  }, [handoff, managed, selection, selections])

  return { state, retry: () => retry.current?.(), recheckPublication }
}
