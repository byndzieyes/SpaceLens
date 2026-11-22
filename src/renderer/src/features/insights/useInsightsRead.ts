import { useEffect, useRef, useState } from 'react'
import type { ScannerIpcResult } from '../../../../shared/ipc'

type ReadState<Data, Query> =
  | { status: 'loading' }
  | { status: 'error'; expired: boolean }
  | { status: 'ready'; data: Data; query: Query }

export interface InsightsSectionProps {
  scanId: string
  recheckPublication: (scanId: string) => Promise<void>
  pageTitle: React.RefObject<HTMLHeadingElement | null>
}

/** Each scan-keyed section owns one read at a time and retries its last request. */
export function useInsightsRead<Data extends { scanId: string }, Query>(
  { scanId, recheckPublication }: InsightsSectionProps,
  read: (scanId: string, query: Query) => Promise<ScannerIpcResult<Data>>,
  initialQuery: NoInfer<Query>
): { state: ReadState<Data, Query>; load: (query: Query) => void; retry: () => void } {
  const [state, setState] = useState<ReadState<Data, Query>>({ status: 'loading' })
  const actions = useRef<{ load: (query: Query) => Promise<void>; retry: () => void } | null>(null)

  useEffect(() => {
    let active = true
    let pending = false
    let lastQuery = initialQuery
    const fail = (detail: unknown, expired = false): void => {
      if (!active) return
      if (import.meta.env.DEV) console.warn('Could not load an Insights section.', detail)
      setState({ status: 'error', expired })
    }
    const load = async (query: Query): Promise<void> => {
      if (!active || pending) return
      pending = true
      lastQuery = query
      setState({ status: 'loading' })
      try {
        const result = await read(scanId, query)
        if (!active) return
        if (!result.ok) {
          const expired = result.error.code === 'SNAPSHOT_EXPIRED'
          if (expired) await recheckPublication(scanId)
          fail(result.error, expired)
        } else if (result.value.scanId !== scanId) {
          fail({ expectedScanId: scanId, receivedScanId: result.value.scanId })
        } else {
          setState({ status: 'ready', data: result.value, query })
        }
      } catch (error) {
        fail(error)
      } finally {
        pending = false
      }
    }

    actions.current = { load, retry: () => void load(lastQuery) }
    // Skip the first Strict Mode effect if its cleanup has already run.
    queueMicrotask(() => void load(initialQuery))
    return () => {
      active = false
      actions.current = null
    }
  }, [scanId, read, initialQuery, recheckPublication])

  return {
    state,
    load: (query) => void actions.current?.load(query),
    retry: () => actions.current?.retry()
  }
}
