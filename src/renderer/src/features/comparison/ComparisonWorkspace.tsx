import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { ArrowLeftRight, GitCompareArrows } from 'lucide-react'
import type { ComparisonPair, ComparisonSide, CompatiblePair } from '../../../../shared/comparison'
import type { ScannerIpcErrorCode } from '../../../../shared/ipc'
import { DEFAULT_SCAN_HISTORY_PAGE_SIZE, type ScanHistoryItem } from '../../../../shared/history'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatPreciseScanDate } from '../../lib/scanDisplay'
import { ComparisonDashboard } from './ComparisonDashboard'
import type { OpenHistoricalEntry } from '../snapshots/useSnapshotNavigation'
import type { OpenComparisonEntry } from './ChangeTables'
import type { ChangeNavigation } from './DetailedChanges'
import { SnapshotPicker, SnapshotSelector } from './SnapshotPicker'
import {
  comparisonError,
  incompatibilityMessage,
  recentDraft,
  sideLabels,
  useComparisonCompatibility,
  useComparisonHistory,
  useComparisonSnapshot,
  type ComparisonDraft
} from './draft'
import {
  useComparisonSelection,
  type ActiveComparison,
  type ComparisonMutations
} from './selection'

const newest = { offset: 0, limit: DEFAULT_SCAN_HISTORY_PAGE_SIZE, sort: 'newest' } as const

function navigationError(code: ScannerIpcErrorCode): string {
  switch (code) {
    case 'ENTRY_NOT_FOUND':
    case 'NOT_DIRECTORY':
    case 'INVALID_REQUEST':
      return 'The saved entry is unavailable. The active comparison is still open.'
    case 'SNAPSHOT_EXPIRED':
    case 'SNAPSHOT_UNAVAILABLE':
      return 'The historical snapshot is unavailable or failed validation.'
    case 'UNAVAILABLE':
    case 'SNAPSHOT_IN_USE':
      return 'Saved scan storage is busy or unavailable. Try opening the entry again.'
    default:
      return 'The saved entry could not be opened.'
  }
}

function CoverageWarnings({
  compatibility
}: {
  compatibility: CompatiblePair
}): React.JSX.Element | null {
  if (compatibility.status !== 'compatible-with-warnings') return null
  return (
    <ul className="space-y-1 text-sm text-warning">
      {compatibility.warnings.map((warning) => (
        <li key={`${warning.side}-${warning.code}`}>
          {warning.code === 'INCOMPLETE_COVERAGE'
            ? `${sideLabels[warning.side]} has partial coverage. Some changes may be uncertain.`
            : `Coverage for the ${warning.side} is unknown.`}
        </li>
      ))}
    </ul>
  )
}

function ActiveComparisonPanel({
  active,
  latestId,
  scanActive,
  onOpenChange,
  navigation,
  onClear
}: {
  active: ActiveComparison
  latestId?: string | null
  scanActive: boolean | undefined
  onOpenChange: OpenComparisonEntry
  navigation?: ChangeNavigation
  onClear: () => void
}): React.JSX.Element {
  return (
    <section aria-labelledby="active-comparison-title" className="min-w-0 space-y-3">
      <Card className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id="active-comparison-title" className="text-base font-semibold">
              Active comparison
            </h3>
            <p className="text-sm text-text-secondary">Changes are Target minus Baseline.</p>
          </div>
          <Button variant="secondary" onClick={onClear}>
            Clear comparison
          </Button>
        </div>
        <dl className="grid min-w-0 gap-3 @min-[38rem]:grid-cols-2">
          {(['baseline', 'target'] as const).map((side) => {
            const scan = active.snapshots[side]
            const latest = latestId === undefined ? scan.isLatest : latestId === scan.id
            return (
              <div key={side} className="min-w-0 space-y-1">
                <dt className="text-xs font-medium text-text-secondary">{sideLabels[side]}</dt>
                <dd className="space-y-1">
                  <p
                    title={scan.rootPath}
                    className="line-clamp-2 text-sm font-medium break-all whitespace-pre-wrap"
                  >
                    {scan.rootPath}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary tabular-nums">
                    <time dateTime={scan.finishedAt}>{formatPreciseScanDate(scan.finishedAt)}</time>
                    {latest && <Badge>Latest</Badge>}
                  </div>
                </dd>
              </div>
            )
          })}
        </dl>
      </Card>
      <ComparisonDashboard
        key={active.selection.selectionId}
        selection={active.selection}
        scanActive={scanActive}
        onOpenChange={onOpenChange}
        navigation={navigation}
      />
    </section>
  )
}

export function ComparisonWorkspace({
  draft,
  setDraft,
  historyRevision,
  scanActive,
  mutations,
  onOpenEntry
}: {
  draft: ComparisonDraft | undefined
  setDraft: Dispatch<SetStateAction<ComparisonDraft | undefined>>
  historyRevision: number
  scanActive: boolean | undefined
  mutations: ComparisonMutations
  onOpenEntry?: OpenHistoricalEntry
}): React.JSX.Element {
  const recent = useComparisonHistory(newest, historyRevision)
  const [picker, setPicker] = useState<ComparisonSide>()
  const [retryNumber, setRetryNumber] = useState(0)
  const [navigation, setNavigation] = useState<ChangeNavigation>()
  const handoff = useRef<{ cancel?: () => void }>(undefined)
  const selection = useComparisonSelection(mutations)
  useLayoutEffect(
    () => () => {
      const current = handoff.current
      handoff.current = undefined
      current?.cancel?.()
    },
    []
  )
  const pair = useMemo<ComparisonPair | undefined>(
    () =>
      draft?.baseline && draft.target
        ? { baselineScanId: draft.baseline.id, targetScanId: draft.target.id }
        : undefined,
    [draft]
  )
  const same = !!pair && pair.baselineScanId === pair.targetScanId
  const baseline = useComparisonSnapshot(draft?.baseline?.id, historyRevision, retryNumber)
  const targetRead = useComparisonSnapshot(
    same ? undefined : draft?.target?.id,
    historyRevision,
    retryNumber
  )
  const target = same ? baseline : targetRead
  const eligible = !same && baseline.status === 'ready' && target.status === 'ready'
  const check = useComparisonCompatibility(
    same ? undefined : pair,
    eligible,
    scanActive,
    retryNumber
  )
  const compatible =
    check?.status === 'checked' && check.value.status !== 'incompatible' ? check.value : undefined
  const unavailable = baseline.status === 'unavailable' || target.status === 'unavailable'
  const missing = baseline.status === 'missing' || target.status === 'missing'
  const busy = scanActive || (check?.status === 'error' && check.code === 'COMPARISON_SCAN_ACTIVE')
  const adopting = selection.pending === 'adopting'
  const canCompare = !!compatible && !busy && scanActive === false && !selection.pending
  const latestId = recent.page?.latestCompletedScanId
  const shownBaseline = baseline.status === 'ready' ? baseline.item : draft?.baseline
  const shownTarget = target.status === 'ready' ? target.item : draft?.target

  useEffect(() => {
    if (draft || !recent.page?.items.length) return
    const suggestion = recentDraft(recent.page.items)
    setDraft((current) => current ?? suggestion)
  }, [draft, recent.page, setDraft])

  useEffect(() => {
    if (!draft?.suggested || check?.status !== 'checked' || check.value.status !== 'incompatible')
      return
    const { code } = check.value.reason
    if (code === 'SNAPSHOT_EXPIRED' || code === 'SNAPSHOT_UNAVAILABLE') return
    setDraft((current) => (current === draft ? { target: current.target } : current))
  }, [check, draft, setDraft])

  const choose = (side: ComparisonSide, scan: ScanHistoryItem): void => {
    if (!selection.changeDraft()) return
    setDraft({ ...draft, [side]: scan, suggested: false })
    setPicker(undefined)
  }
  const swap = (): void => {
    if (!selection.changeDraft()) return
    setDraft({ baseline: shownTarget, target: shownBaseline })
  }
  const cancelNavigation = (): void => {
    const current = handoff.current
    handoff.current = undefined
    current?.cancel?.()
    setNavigation(undefined)
  }
  const openChange: OpenComparisonEntry = (side, entry) => {
    if (!selection.active || !onOpenEntry) return
    if (selection.pending) {
      setNavigation({
        status: 'opening',
        message: 'Wait for the replacement to finish before opening an entry.'
      })
      return
    }
    const { pair } = selection.active.selection.compatibility
    const scanId = side === 'baseline' ? pair.baselineScanId : pair.targetScanId
    if (entry.scanId !== scanId || (entry.type !== 'file' && entry.type !== 'directory')) return
    cancelNavigation()
    const request: { cancel?: () => void } = {}
    handoff.current = request
    setNavigation({ status: 'opening', message: 'Opening saved entry in Explorer…' })
    request.cancel = onOpenEntry({ scanId, entryId: entry.entryId, type: entry.type }, (code) => {
      if (handoff.current !== request) return
      handoff.current = undefined
      setNavigation(code ? { status: 'error', message: navigationError(code) } : undefined)
    })
  }
  const compare = (): void => {
    if (!canCompare || !pair || baseline.status !== 'ready' || target.status !== 'ready') return
    cancelNavigation()
    selection.start(pair, { baseline: baseline.item, target: target.item })
  }
  const retry = (): void => {
    if (recent.error) recent.retry()
    setRetryNumber((value) => value + 1)
  }

  let status = 'Choose a baseline and target to check compatibility.'
  if (recent.page && recent.page.totalCount < 2)
    status = recent.page.totalCount
      ? 'One saved snapshot is available. Run another scan to compare.'
      : 'Save two snapshots to compare.'
  else if (same) status = 'Choose two different snapshots.'
  else if (missing) status = 'Choose a replacement for the snapshot that is no longer retained.'
  else if (unavailable) status = 'Snapshot metadata could not be loaded.'
  else if (busy) status = comparisonError('COMPARISON_SCAN_ACTIVE')
  else if (check?.status === 'error') status = comparisonError(check.code)
  else if (check?.status === 'checked') {
    status =
      check.value.status === 'incompatible'
        ? incompatibilityMessage(check.value.reason)
        : compatible?.status === 'compatible-with-warnings'
          ? 'Compatible with coverage limitations.'
          : 'These snapshots are compatible.'
  } else if (pair) status = 'Checking compatibility…'
  else if (recent.loading && !draft) status = 'Loading saved snapshots…'
  else if (recent.error && !draft) status = 'Saved snapshots could not be loaded.'

  return (
    <div className="@container min-w-0 space-y-4">
      <Card aria-labelledby="comparison-selection-title" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="comparison-selection-title" className="text-base font-semibold">
            Compare snapshots
          </h3>
          {selection.active && <Badge>Editing draft</Badge>}
        </div>
        <div className="grid min-w-0 items-stretch gap-2.5 @min-[38rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <SnapshotSelector
            side="baseline"
            scan={shownBaseline}
            latest={latestId === undefined ? undefined : latestId === shownBaseline?.id}
            status={baseline.status}
            disabled={adopting}
            onOpen={() => setPicker('baseline')}
          />
          <Button
            variant="secondary"
            aria-label="Swap baseline and target"
            title="Swap baseline and target"
            className="size-10 self-center justify-self-center p-0!"
            disabled={adopting || !pair || same}
            onClick={swap}
          >
            <ArrowLeftRight
              size={17}
              aria-hidden="true"
              className="shrink-0 rotate-90 @min-[38rem]:rotate-0"
            />
          </Button>
          <SnapshotSelector
            side="target"
            scan={shownTarget}
            latest={latestId === undefined ? undefined : latestId === shownTarget?.id}
            status={target.status}
            disabled={adopting}
            onOpen={() => setPicker('target')}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-separator pt-3">
          <div className="min-w-0 flex-[1_1_16rem] space-y-1.5">
            <p role="status" className={`text-sm ${busy ? 'text-warning' : 'text-text-secondary'}`}>
              {status}
            </p>
            {compatible && !busy && <CoverageWarnings compatibility={compatible} />}
            {selection.failure && (
              <p role="alert" className="text-sm text-error">
                {comparisonError(selection.failure.code, selection.failure.operation)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!scanActive &&
              !selection.pending &&
              (check?.status === 'error' || unavailable || recent.error) && (
                <Button variant="secondary" onClick={retry}>
                  Retry
                </Button>
              )}
            {!selection.active && selection.pending && (
              <Button variant="secondary" onClick={selection.clear}>
                Cancel preparation
              </Button>
            )}
            <Button
              disabled={!canCompare && !selection.pending}
              aria-disabled={!!selection.pending}
              className="aria-disabled:opacity-60"
              onClick={compare}
            >
              <GitCompareArrows size={16} aria-hidden="true" />
              {adopting
                ? 'Activating comparison…'
                : selection.pending
                  ? 'Preparing comparison…'
                  : 'Compare snapshots'}
            </Button>
          </div>
        </div>
      </Card>
      {selection.active && (
        <ActiveComparisonPanel
          active={selection.active}
          latestId={latestId}
          scanActive={scanActive}
          onOpenChange={openChange}
          navigation={navigation}
          onClear={() => {
            cancelNavigation()
            selection.clear()
          }}
        />
      )}
      {picker && (
        <SnapshotPicker
          title={`Choose ${sideLabels[picker].toLowerCase()} snapshot`}
          selectedId={draft?.[picker]?.id}
          recent={recent}
          historyRevision={historyRevision}
          onSelect={(scan) => choose(picker, scan)}
          onDismiss={() => setPicker(undefined)}
        />
      )}
    </div>
  )
}
