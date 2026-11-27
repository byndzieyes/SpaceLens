import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SCAN_HISTORY_PAGE_SIZE,
  type ScanHistoryErrorCode,
  type ScanHistoryPage,
  type ScanHistorySort
} from '../../../../shared/history'
import type { ScanStateSnapshot } from '../../../../shared/ipc'
import type { SnapshotSelections } from '../snapshots/selection'

type HistoryState =
  | { status: 'loading'; page: ScanHistoryPage | null }
  | { status: 'ready'; page: ScanHistoryPage }
  | { status: 'error'; page: ScanHistoryPage | null; message: string }

interface HistoryQuery {
  readonly path: string
  readonly sort: ScanHistorySort
  readonly offset: number
}

const pageSize = DEFAULT_SCAN_HISTORY_PAGE_SIZE
const pathDelay = 250
const initialQuery: HistoryQuery = { path: '', sort: 'newest', offset: 0 }
const loading: HistoryState = { status: 'loading', page: null }

function errorMessage(code?: ScanHistoryErrorCode): string {
  if (code === 'UNAVAILABLE' || code === 'SNAPSHOT_UNAVAILABLE')
    return 'Saved scan storage is unavailable.'
  return 'Scan history could not be loaded.'
}

export function useScanHistory(
  snapshots: SnapshotSelections,
  showScans: boolean
): {
  state: HistoryState
  filter: string
  sort: ScanHistorySort
  setFilter: (path: string) => void
  setSort: (sort: ScanHistorySort) => void
  previous: (() => void) | null
  next: (() => void) | null
  retry: () => void
  historyRevision: number
  retainedCount: number | undefined
  latestCompletedScanId: string | null | undefined
  scanActive: boolean | undefined
} {
  const [filter, setDraft] = useState('')
  const [query, setQuery] = useState(initialQuery)
  const [result, setResult] = useState<{ query: HistoryQuery; state: HistoryState }>()
  const [historyRevision, setHistoryRevision] = useState(0)
  const [retained, setRetained] = useState<{ revision: number; count: number }>()
  const [latestCompletedScanId, setLatestCompletedScanId] = useState<string | null>()
  const [scanActive, setScanActive] = useState<boolean>()
  const scannerRevision = useRef(-1)
  const wantedRevision = useRef(0)
  const wantedRead = useRef(0)
  const refresh = useRef<() => void>(null)
  const retry = (): void => {
    wantedRead.current++
    refresh.current?.()
  }

  const observe = useCallback((snapshot: ScanStateSnapshot): void => {
    if (snapshot.revision > scannerRevision.current) {
      scannerRevision.current = snapshot.revision
      setScanActive(snapshot.state?.session.status === 'running')
    }
    const revision = snapshot.historyRevision ?? 0
    if (revision <= wantedRevision.current) return
    wantedRevision.current = revision
    wantedRead.current++
    setHistoryRevision(revision)
    refresh.current?.()
  }, [])

  useEffect(() => snapshots.subscribeScanState(observe), [observe, snapshots])

  useEffect(() => {
    if (showScans) return
    let active = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.spaceLens.getScanState()
        if (!active) return
        if (result.ok) {
          snapshots.observeScanState(result.value)
          observe(result.value)
          return
        }
      } catch {
        // Comparison IPC still enforces scanner admission if the state read fails.
      }
      if (active) setScanActive((current) => current ?? false)
    }
    void load()
    return () => {
      active = false
    }
  }, [observe, showScans, snapshots])

  useEffect(() => {
    if (filter === query.path) return
    const timer = setTimeout(() => {
      setQuery((current) =>
        current.path === filter ? current : { ...current, path: filter, offset: 0 }
      )
    }, pathDelay)
    return () => clearTimeout(timer)
  }, [filter, query.path])

  useEffect(() => {
    if (!showScans) return
    let active = true
    let scheduled = false
    let reading = false
    let page: ScanHistoryPage | null = null

    const schedule = (): void => {
      if (!active || scheduled || reading) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (active) void load()
      })
    }

    const load = async (): Promise<void> => {
      const read = wantedRead.current
      const isCurrent = (): boolean => active && read === wantedRead.current
      const update = (state: HistoryState): void => setResult({ query, state })
      reading = true
      update({ status: 'loading', page })
      try {
        const result = await window.spaceLens.listScanHistory({
          offset: query.offset,
          limit: pageSize,
          sort: query.sort,
          ...(query.path && { rootPathContains: query.path })
        })
        if (!isCurrent()) return
        if (!result.ok) {
          update({ status: 'error', page, message: errorMessage(result.error.code) })
          return
        }
        const nextPage = result.value
        setLatestCompletedScanId(nextPage.latestCompletedScanId)
        if (!query.path)
          setRetained({ revision: wantedRevision.current, count: nextPage.totalCount })
        if (query.offset > 0 && query.offset >= nextPage.totalCount) {
          const lastOffset = Math.max(0, Math.ceil(nextPage.totalCount / pageSize) - 1) * pageSize
          // An offset correction can only move back, even if more snapshots disappear.
          setQuery((current) => (current === query ? { ...current, offset: lastOffset } : current))
          return
        }
        page = nextPage
        update({ status: 'ready', page })
      } catch {
        if (isCurrent()) update({ status: 'error', page, message: errorMessage() })
      } finally {
        reading = false
        if (read !== wantedRead.current) schedule()
      }
    }

    refresh.current = schedule
    schedule()
    return () => {
      active = false
      refresh.current = null
    }
  }, [query, showScans])

  const state = result?.query === query && filter === query.path ? result.state : loading
  const { page } = state
  const previous = page && page.offset > 0 ? Math.max(0, page.offset - pageSize) : null
  const next = page?.nextOffset ?? null
  const goTo = (offset: number): void =>
    setQuery((current) => (current === query ? { ...current, offset } : current))

  return {
    state,
    filter,
    sort: query.sort,
    setFilter: (path) => {
      setDraft(path)
      if (path === '')
        setQuery((current) =>
          current.path === '' && current.offset === 0 ? current : { ...current, path, offset: 0 }
        )
    },
    setSort: (sort) =>
      setQuery((current) => (current.sort === sort ? current : { path: filter, sort, offset: 0 })),
    previous: previous === null ? null : () => goTo(previous),
    next: next === null ? null : () => goTo(next),
    retry,
    historyRevision,
    retainedCount: retained?.revision === historyRevision ? retained.count : undefined,
    latestCompletedScanId,
    scanActive
  }
}
