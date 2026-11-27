import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComparisonCompatibility,
  ComparisonErrorCode,
  ComparisonIncompatibility,
  ComparisonPair,
  ComparisonSide
} from '../../../../shared/comparison'
import type { ScanHistoryItem, ScanHistoryPage, ScanHistoryQuery } from '../../../../shared/history'

export interface ComparisonDraft {
  readonly baseline?: ScanHistoryItem
  readonly target?: ScanHistoryItem
  readonly suggested?: boolean
}

export const sideLabels = { baseline: 'Baseline', target: 'Target' } satisfies Record<
  ComparisonSide,
  string
>

export function recentDraft(items: readonly ScanHistoryItem[]): ComparisonDraft {
  // The newest-publication query defines direction. A matching root spelling is
  // only a hint for the bounded candidate; the Main API decides compatibility.
  for (const [index, target] of items.entries()) {
    const baseline = items.slice(index + 1).find((item) => item.rootPath === target.rootPath)
    if (baseline) return { baseline, target, suggested: true }
  }
  return { baseline: items[1], target: items[0], suggested: items.length > 1 }
}

type PageResult = { page: ScanHistoryPage; error?: never } | { page?: never; error: true }

export function useComparisonHistory(
  query: ScanHistoryQuery | undefined,
  historyRevision: number
): {
  page: ScanHistoryPage | undefined
  loading: boolean
  error: boolean
  retry: () => void
} {
  const [retryNumber, setRetry] = useState(0)
  const read = useMemo(
    () => ({ query, historyRevision, retryNumber }),
    [query, historyRevision, retryNumber]
  )
  const [result, setResult] = useState<PageResult & { read: typeof read }>()

  useEffect(() => {
    if (!read.query) return
    const request = read.query
    let active = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.spaceLens.listScanHistory(request)
        if (active) setResult(result.ok ? { read, page: result.value } : { read, error: true })
      } catch {
        if (active) setResult({ read, error: true })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [read])

  return {
    page: result?.read === read ? result.page : undefined,
    loading: !!query && result?.read !== read,
    error: result?.read === read && !!result.error,
    retry: () => setRetry((value) => value + 1)
  }
}

type SnapshotRead =
  { status: 'ready'; item: ScanHistoryItem } | { status: 'missing' | 'unavailable' }
type SnapshotStatus = SnapshotRead | { status: 'empty' | 'loading' }

export function useComparisonSnapshot(
  id: string | undefined,
  historyRevision: number,
  retryNumber: number
): SnapshotStatus {
  const [result, setResult] = useState<SnapshotRead & { id: string }>()

  useEffect(() => {
    if (!id) return
    const scanId = id
    let active = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.spaceLens.getScanHistoryMetadata({ scanId })
        if (!active) return
        if (result.ok && result.value.id === scanId)
          setResult({ id: scanId, status: 'ready', item: result.value })
        else
          setResult({
            id: scanId,
            status:
              !result.ok && result.error.code === 'SNAPSHOT_EXPIRED' ? 'missing' : 'unavailable'
          })
      } catch {
        if (active) setResult({ id: scanId, status: 'unavailable' })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [id, historyRevision, retryNumber])

  if (!id) return { status: 'empty' }
  return result?.id === id ? result : { status: 'loading' }
}

type CompatibilityState =
  | { status: 'checked'; value: ComparisonCompatibility }
  | { status: 'error'; code: ComparisonErrorCode }

export function useComparisonCompatibility(
  pair: ComparisonPair | undefined,
  eligible: boolean,
  scanActive: boolean | undefined,
  retryNumber: number
): CompatibilityState | undefined {
  const check = useMemo(() => ({ pair, retryNumber }), [pair, retryNumber])
  const [result, setResult] = useState<CompatibilityState & { check: typeof check }>()
  const blocked = useRef<typeof check>(undefined)

  useEffect(() => {
    if (!check.pair || scanActive === undefined) return
    const pair = check.pair
    let active = true
    const error = (code: ComparisonErrorCode): void => {
      if (!active) return
      if (code === 'COMPARISON_SCAN_ACTIVE') blocked.current = check
      setResult({ check, status: 'error', code })
    }
    const evaluate = async (): Promise<void> => {
      if (!active) return
      if (scanActive) {
        error('COMPARISON_SCAN_ACTIVE')
        return
      }
      if (!eligible || blocked.current === check) return
      try {
        const result = await window.spaceLens.evaluateComparisonCompatibility(pair)
        if (!active) return
        if (!result.ok) error(result.error.code)
        else if (
          pair.baselineScanId !== result.value.pair.baselineScanId ||
          pair.targetScanId !== result.value.pair.targetScanId
        )
          error('INTERNAL_ERROR')
        else setResult({ check, status: 'checked', value: result.value })
      } catch {
        error('UNAVAILABLE')
      }
    }
    queueMicrotask(() => void evaluate())
    return () => {
      active = false
    }
  }, [check, eligible, scanActive])

  return eligible && result?.check === check ? result : undefined
}

export function incompatibilityMessage(reason: ComparisonIncompatibility): string {
  switch (reason.code) {
    case 'SAME_SNAPSHOT':
      return 'Choose two different snapshots.'
    case 'DIFFERENT_ROOTS':
      return 'These snapshots were scanned from different roots.'
    case 'INCOMPATIBLE_SCAN_SEMANTICS':
      return 'These snapshots were created using incompatible scan rules.'
    case 'INSUFFICIENT_COMPATIBILITY_METADATA':
      return 'There is too little saved information to establish compatibility.'
    case 'SNAPSHOT_EXPIRED':
      return `The ${sideLabels[reason.side].toLowerCase()} snapshot is no longer retained.`
    case 'SNAPSHOT_UNAVAILABLE':
      return `The ${sideLabels[reason.side].toLowerCase()} snapshot is unavailable.`
  }
}

export function comparisonError(
  code: ComparisonErrorCode,
  operation?: 'prepare' | 'adopt' | 'release'
): string {
  if (operation === 'release')
    return 'The release could not be confirmed. Reopen SpaceLens if the snapshots remain in use.'
  switch (code) {
    case 'COMPARISON_SCAN_ACTIVE':
      return 'Comparison checks are paused while a scan is active. Retry after the scan finishes.'
    case 'COMPARISON_TIMEOUT':
      return 'The comparison request timed out. Retry when saved scan storage is available.'
    case 'SNAPSHOT_EXPIRED':
      return operation === 'adopt'
        ? 'This preparation expired or was replaced. Prepare the comparison again.'
        : 'A selected snapshot is no longer retained.'
    case 'SNAPSHOT_UNAVAILABLE':
    case 'AMBIGUOUS_COMPARISON_PATH':
    case 'INVALID_COMPARISON_PATH':
      return operation === 'prepare'
        ? 'A saved snapshot failed historical validation.'
        : 'A selected snapshot is unavailable.'
    case 'UNAVAILABLE':
    case 'UNAUTHORIZED':
      return 'Saved scan storage is unavailable. Reopen SpaceLens if this persists.'
    case 'SNAPSHOT_IN_USE':
      return 'A selected snapshot is busy. Try again after the other operation finishes.'
    case 'INCOMPATIBLE_SNAPSHOTS':
      return 'These saved snapshots are incompatible.'
    default:
      return operation === 'prepare'
        ? 'The comparison could not be prepared.'
        : operation === 'adopt'
          ? 'The prepared comparison could not be activated.'
          : 'Compatibility could not be checked.'
  }
}
