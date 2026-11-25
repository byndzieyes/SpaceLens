import { useCallback, useEffect, useRef, useState } from 'react'
import type { InsightsSummary } from '../../../../shared/insights'
import type { ScanStateSnapshot, ScannerIpcErrorCode } from '../../../../shared/ipc'
import { followLatest } from '../../../../shared/snapshotSelection'
import { useSnapshotSelections, type ViewSnapshotOptions } from '../snapshots/selection'

type ReadFailure = { code: ScannerIpcErrorCode; message: string }
type ExpiredReference =
  | { scanId: string; source: 'summary'; error: ReadFailure }
  | { scanId: string; source: 'analytics' }
type AnalyticsScope = { scanId: string; generation: string }
type InsightsState =
  | { status: 'loading'; refreshing: boolean; analytics?: AnalyticsScope }
  | { status: 'no-snapshot' }
  | { status: 'ready'; summary: InsightsSummary; analytics: AnalyticsScope }
  | { status: 'error'; reason: 'expired' | 'unavailable' | 'read'; analytics?: AnalyticsScope }

const initialState: InsightsState = { status: 'loading', refreshing: false }

export function useInsights(snapshots?: ViewSnapshotOptions): {
  state: InsightsState
  historical: boolean
  retry: () => void
  recheckPublication: (scanId: string) => Promise<void>
} {
  const selections = useSnapshotSelections(snapshots?.controller)
  const selection = snapshots?.selection ?? followLatest
  const handoff = snapshots?.handoff
  const managed = snapshots !== undefined
  const [state, setState] = useState<InsightsState>(initialState)
  const [historical, setHistorical] = useState(false)
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
    let resolved: AnalyticsScope | undefined
    let resolvedEmpty = false
    let request: { target?: AnalyticsScope; visible?: AnalyticsScope } | undefined
    let started = false

    const load = async (
      refreshing: boolean,
      expired?: ExpiredReference,
      retained?: AnalyticsScope,
      initialHandoff?: ViewSnapshotOptions['handoff']
    ): Promise<void> => {
      // A section failure stays local unless the selected scan changes or becomes unavailable.
      const verifyingAnalytics = expired?.source === 'analytics'
      const pending: NonNullable<typeof request> = {
        visible: verifyingAnalytics ? resolved : retained
      }
      const announcedAtStart = announcedScanId
      started = true
      request = pending
      const clearSummary = (analytics?: AnalyticsScope): void => {
        resolved = undefined
        resolvedEmpty = false
        setState({ status: 'loading', refreshing, analytics })
      }
      if (!verifyingAnalytics) clearSummary(retained)

      const isCurrent = (): boolean => active && request === pending
      const fail = (detail: unknown, code?: ScannerIpcErrorCode): void => {
        if (!isCurrent()) return
        if (import.meta.env.DEV)
          console.warn('Could not load Insights for the selected scan.', detail)
        if (
          verifyingAnalytics &&
          resolved !== undefined &&
          (selection.mode === 'follow-latest' ||
            (code !== 'SNAPSHOT_UNAVAILABLE' && code !== 'SNAPSHOT_EXPIRED'))
        )
          return
        const reason =
          code === 'SNAPSHOT_EXPIRED'
            ? 'expired'
            : code === 'SNAPSHOT_UNAVAILABLE'
              ? 'unavailable'
              : 'read'
        resolved = reason === 'read' ? (pending.target ?? pending.visible) : undefined
        setState({ status: 'error', reason, analytics: resolved })
      }

      try {
        const result = await selections.loadInsights(
          selection,
          isCurrent,
          initialHandoff,
          pending.visible !== undefined
        )
        if (!isCurrent()) return
        const scanId = result.ok ? result.value.scanId : undefined
        // A publication can be announced while the metadata read is returning an older snapshot.
        if (announcedScanId !== announcedAtStart && scanId !== announcedScanId) {
          void load(true, expired, pending.visible)
          return
        }
        if (!result.ok) {
          fail(result.error, result.error.code)
          return
        }
        setHistorical(selections.isHistoricalSelection('insights'))
        if (!scanId) {
          const { unavailable } = result.value
          if (unavailable) fail(unavailable, 'SNAPSHOT_UNAVAILABLE')
          else {
            resolved = undefined
            resolvedEmpty = true
            setState({ status: 'no-snapshot' })
          }
          return
        }
        const scope = { scanId, generation: result.value.generation }
        if (expired?.scanId === scanId) {
          if (expired.source === 'summary') {
            fail(expired.error, expired.error.code)
            return
          }
          if (!pending.visible) {
            fail({ scanId, announcedScanId }, 'SNAPSHOT_EXPIRED')
            return
          }
          if (pending.visible.generation === scope.generation) return
        }

        if (pending.visible && pending.visible.generation !== scope.generation) clearSummary()
        pending.target = scope
        const resultSummary = await api.getInsightsSummary({ scanId })
        if (!isCurrent()) return
        if (!resultSummary.ok) {
          const { error } = resultSummary
          // The worker may see the replacement before its notification reaches the renderer.
          if (
            selection.mode === 'follow-latest' &&
            error.code === 'SNAPSHOT_EXPIRED' &&
            expired?.source !== 'summary'
          ) {
            void load(true, { scanId, error, source: 'summary' })
          } else fail(error, error.code)
          return
        }
        if (resultSummary.value.scanId !== scanId) {
          fail({ expectedScanId: scanId, receivedScanId: resultSummary.value.scanId })
          return
        }
        resolved = scope
        setState({ status: 'ready', summary: resultSummary.value, analytics: scope })
      } catch (error) {
        fail(error)
      } finally {
        if (isCurrent()) request = undefined
      }
    }

    const unsubscribe = selections.subscribeScanState((update: ScanStateSnapshot) => {
      if (!active || update.revision <= revision) return
      revision = update.revision
      if (selection.mode === 'explicit') {
        setHistorical(selections.isHistoricalSelection('insights'))
        return
      }
      const published =
        update.latestCompleted?.id ??
        (update.latestCompleted === null && update.historyRevision !== undefined ? null : undefined)
      if (published === undefined || published === announcedScanId) return
      announcedScanId = published
      if (published === null) {
        if (resolvedEmpty || (request && !request.target && !request.visible)) return
        void load(resolved !== undefined || request !== undefined)
        return
      }
      if (
        published === resolved?.scanId ||
        published === request?.target?.scanId ||
        published === request?.visible?.scanId
      ) {
        return
      }
      if (request && !request.target) {
        // Keep the pending metadata read, but retire the old view as soon as Main announces a replacement.
        if (request.visible) {
          request.visible = undefined
          resolved = undefined
          setState({ status: 'loading', refreshing: true })
        }
        return
      }
      void load(resolved !== undefined || request !== undefined)
    })

    retry.current = () => {
      if (active && !request) void load(false, undefined, resolved)
    }
    recheck.current = async (scanId) => {
      if (active && !request && resolved?.scanId === scanId) {
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

  return { state, historical, retry: () => retry.current?.(), recheckPublication }
}
