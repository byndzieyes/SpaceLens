import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ResolvedScanHistoryQuery,
  ScanHistoryErrorCode,
  ScanHistoryPage
} from '../../../../shared/history'

const recentQuery: ResolvedScanHistoryQuery = { offset: 0, limit: 5, sort: 'newest' }

export type RecentScansState =
  | { status: 'loading'; page: ScanHistoryPage | null }
  | { status: 'ready'; page: ScanHistoryPage }
  | { status: 'error'; page: ScanHistoryPage | null; message: string }

function historyError(code?: ScanHistoryErrorCode): string {
  switch (code) {
    case 'UNAVAILABLE':
    case 'SNAPSHOT_UNAVAILABLE':
      return 'Saved scan storage is unavailable.'
    case 'UNAUTHORIZED':
      return 'Recent scans are unavailable in this window.'
    default:
      return 'Recent scans could not be loaded.'
  }
}

export function useRecentScans(): {
  state: RecentScansState
  observeRevision: (revision: number) => void
  retry: () => void
} {
  const [state, setState] = useState<RecentScansState>({ status: 'loading', page: null })
  const actions = useRef<{ observe: (revision: number) => void; retry: () => void }>(null)
  const observeRevision = useCallback((revision: number) => actions.current?.observe(revision), [])

  useEffect(() => {
    let active = true
    let scheduled = false
    let reading = false
    let wantedRevision = 0
    let page: ScanHistoryPage | null = null

    const schedule = (): void => {
      if (!active || reading || scheduled) return
      scheduled = true
      // Let Overview attach its scanner subscription before issuing the initial request.
      queueMicrotask(() => {
        scheduled = false
        if (active) void load()
      })
    }
    const load = async (): Promise<void> => {
      const revision = wantedRevision
      const current = (): boolean => active && revision === wantedRevision
      reading = true
      setState({ status: 'loading', page })
      try {
        const result = await window.spaceLens.listScanHistory(recentQuery)
        if (!current()) return
        if (result.ok) {
          page = result.value
          setState({ status: 'ready', page })
        } else {
          setState({ status: 'error', page, message: historyError(result.error.code) })
        }
      } catch {
        if (current()) setState({ status: 'error', page, message: historyError() })
      } finally {
        reading = false
        // Multiple committed mutations need only one more page from the current history.
        if (revision !== wantedRevision) schedule()
      }
    }
    actions.current = {
      observe: (revision) => {
        if (revision <= wantedRevision) return
        wantedRevision = revision
        schedule()
      },
      retry: schedule
    }
    schedule()
    return () => {
      active = false
      actions.current = null
    }
  }, [])

  return { state, observeRevision, retry: () => actions.current?.retry() }
}
