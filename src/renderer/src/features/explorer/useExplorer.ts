import { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '../../../../shared/scan'
import { followLatest } from '../../../../shared/snapshotSelection'
import type { ExplorerTarget } from '../../navigation'
import { useSnapshotSelections, type ViewSnapshotOptions } from '../snapshots/selection'
import {
  invalidExplorerEntry,
  isStaleSnapshotError,
  locateFileContentsPage,
  resolveDirectoryAncestry,
  resolveExplorerSnapshot,
  type ExplorerAccessError,
  type ExplorerSnapshotState,
  type LocatedContentsPage
} from './data'

type NavigationMode = 'new' | 'back' | 'forward'
type RequestError = ExplorerAccessError | { code: 'TRANSPORT_ERROR'; message: string }
export interface ExplorerState {
  availability: ExplorerSnapshotState | null
  breadcrumbs: readonly FileEntry[]
  selectedEntryId: string | null
  back: readonly string[]
  forward: readonly string[]
  loading: boolean
  error: RequestError | null
  targetNotice: string | null
  revealPath: boolean
  fileArrival?: { entry: FileEntry; contents: LocatedContentsPage }
}
const initial: ExplorerState = {
  availability: null,
  breadcrumbs: [],
  selectedEntryId: null,
  back: [],
  forward: [],
  loading: true,
  error: null,
  targetNotice: null,
  revealPath: false
}
const scanChanged = 'The scan has changed. Browse the current snapshot in Explorer.'
const missingTarget = 'The ranked item is unavailable. Browse the current snapshot in Explorer.'

function requestError(error: unknown, fallback: string): RequestError {
  return error && typeof error === 'object' && 'code' in error && 'message' in error
    ? (error as ExplorerAccessError)
    : { code: 'TRANSPORT_ERROR', message: fallback }
}

function enterDirectory(
  before: ExplorerState,
  breadcrumbs: readonly FileEntry[],
  mode: NavigationMode
): ExplorerState {
  const previous = before.breadcrumbs.at(-1)?.id
  const destination: ExplorerState = {
    ...before,
    breadcrumbs,
    selectedEntryId: null,
    fileArrival: undefined,
    loading: false,
    error: null,
    targetNotice: null
  }
  if (!previous || previous === breadcrumbs.at(-1)?.id) return destination
  return {
    ...destination,
    back: mode === 'back' ? before.back.slice(0, -1) : [...before.back, previous],
    forward:
      mode === 'forward'
        ? before.forward.slice(0, -1)
        : mode === 'back'
          ? [...before.forward, previous]
          : []
  }
}

export function useExplorer(
  target?: ExplorerTarget,
  onTargetConsumed?: (target: ExplorerTarget) => void,
  snapshots?: ViewSnapshotOptions
): ExplorerState & {
  currentDirectoryId: string | null
  historical: boolean
  navigateToDirectory: (id: string) => Promise<void>
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  goUp: () => Promise<void>
  selectEntry: (id: string | null) => void
  refreshSnapshot: () => Promise<void>
} {
  const selections = useSnapshotSelections(snapshots?.controller)
  const selection = snapshots?.selection ?? followLatest
  const [state, setState] = useState<ExplorerState>(initial)
  const [historical, setHistorical] = useState(false)
  const current = useRef(state)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const refreshing = useRef(false)
  const openingTarget = useRef<ExplorerTarget | undefined>(undefined)
  const publish = (next: ExplorerState): void => {
    current.current = next
    setState(next)
  }
  const refreshSnapshot = async (
    replacing = false,
    intent?: ExplorerTarget,
    targetNotice = replacing ? current.current.targetNotice : null,
    handoff?: ViewSnapshotOptions['handoff']
  ): Promise<void> => {
    if (!mounted.current) return
    const ticket = ++sequence.current
    const isCurrent = (): boolean => mounted.current && ticket === sequence.current
    refreshing.current = true
    openingTarget.current = intent
    publish({
      ...(replacing ? initial : current.current),
      loading: true,
      error: null,
      targetNotice
    })
    try {
      const result = await resolveExplorerSnapshot(() =>
        selections.loadExplorer(selection, isCurrent, handoff)
      )
      if (!isCurrent()) return
      if (!result.ok) {
        publish({ ...initial, loading: false, error: result.error, targetNotice })
        return
      }
      setHistorical(selections.isHistoricalSelection('explorer'))
      const previous = current.current
      const availability = result.value
      const same =
        availability.status === 'available' &&
        previous.availability?.status === 'available' &&
        availability.snapshot.entries.scanId === previous.availability.snapshot.entries.scanId
      const resolved = {
        ...(same ? previous : initial),
        availability,
        loading: false,
        error: null,
        targetNotice,
        breadcrumbs: same
          ? previous.breadcrumbs
          : availability.status === 'available'
            ? [availability.snapshot.root]
            : []
      }
      if (!intent) {
        publish(resolved)
        return
      }
      if (
        availability.status !== 'available' ||
        availability.snapshot.entries.scanId !== intent.scanId
      ) {
        publish({ ...resolved, targetNotice: scanChanged })
        return
      }

      try {
        let file: FileEntry | undefined
        if (intent.type === 'file') {
          const entry = await window.spaceLens.getScanEntry({
            scanId: intent.scanId,
            entryId: intent.entryId
          })
          if (!isCurrent()) return
          if (!entry.ok) throw entry.error
          file = entry.value
          if (
            file.scanId !== intent.scanId ||
            file.id !== intent.entryId ||
            file.parentId !== intent.parentId ||
            file.type !== 'file'
          )
            throw invalidExplorerEntry('The ranked file does not match its published entry.')
        }
        const directoryId = file ? intent.parentId : intent.entryId
        const chain = await resolveDirectoryAncestry(availability.snapshot, directoryId, isCurrent)
        if (!chain || !isCurrent()) return
        if (!file && chain.at(-1)?.parentId !== intent.parentId)
          throw invalidExplorerEntry('The ranked directory does not match its published parent.')
        const destination = { ...enterDirectory(resolved, chain, 'new'), revealPath: true }
        if (file) {
          const contents = await locateFileContentsPage(
            { scanId: intent.scanId, entryId: directoryId },
            file,
            isCurrent
          )
          if (!contents || !isCurrent()) return
          publish({
            ...destination,
            selectedEntryId: file.id,
            fileArrival: { entry: file, contents }
          })
        } else publish(destination)
      } catch (error) {
        if (!isCurrent()) return
        const failure = requestError(
          error,
          'The ranked item could not be opened. Browse the current snapshot in Explorer.'
        )
        if (isStaleSnapshotError(failure.code)) void refreshSnapshot(true, undefined, scanChanged)
        else if (
          failure.code === 'ENTRY_NOT_FOUND' ||
          failure.code === 'INVALID_REQUEST' ||
          failure.code === 'NOT_DIRECTORY'
        )
          publish({ ...resolved, targetNotice: missingTarget })
        else publish({ ...resolved, error: failure })
      }
    } catch {
      if (mounted.current && ticket === sequence.current)
        publish({
          ...initial,
          loading: false,
          targetNotice,
          error: {
            code: 'TRANSPORT_ERROR',
            message: 'Snapshot availability could not be loaded. Retry the request.'
          }
        })
    } finally {
      if (ticket === sequence.current) {
        refreshing.current = false
        openingTarget.current = undefined
      }
    }
  }
  useEffect(() => {
    const requests = sequence
    mounted.current = true
    const ticket = requests.current
    let revision = -1
    let latestPublished: string | null | undefined
    let waitingTarget = target
    const unsubscribe = selections.subscribeScanState((update) => {
      if (update.revision <= revision) return
      revision = update.revision
      if (selection.mode === 'explicit') {
        setHistorical(selections.isHistoricalSelection('explorer'))
        return
      }
      const session = update.state?.session
      // Recovery metadata arrives with an idle scanner. The initial SQLite read already waits for it.
      if (!session && update.historyRevision === undefined) return
      const published =
        update.latestCompleted?.id ??
        (update.latestCompleted === null
          ? null
          : session?.status === 'completed'
            ? session.id
            : undefined)
      if (published === undefined || latestPublished === published) return
      latestPublished = published
      if (waitingTarget) return
      if (openingTarget.current) {
        if (openingTarget.current.scanId !== published)
          void refreshSnapshot(true, undefined, scanChanged)
        return
      }
      const { availability } = current.current
      const previous = availability ? (availability.snapshot?.entries.scanId ?? null) : undefined
      if (previous !== published) void refreshSnapshot(previous !== undefined)
    })
    // A discarded Strict Mode mount does not need its own availability request.
    queueMicrotask(() => {
      if (requests.current !== ticket) return
      const intent = waitingTarget
      waitingTarget = undefined
      if (intent) onTargetConsumed?.(intent)
      void refreshSnapshot(false, intent, null, snapshots?.handoff)
    })
    return () => {
      mounted.current = false
      requests.current++
      refreshing.current = false
      openingTarget.current = undefined
      unsubscribe()
      if (!snapshots) selections.release('explorer')
    }
    // Availability is queried on activation and when the scanner reports a new publication.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const navigate = async (entryId: string, mode: NavigationMode = 'new'): Promise<void> => {
    const before = current.current
    if (!mounted.current || refreshing.current || before.availability?.status !== 'available')
      return
    const snapshot = before.availability.snapshot
    const oldId = before.breadcrumbs.at(-1)?.id
    const ticket = ++sequence.current
    if (entryId === oldId) {
      publish({ ...before, loading: false })
      return
    }
    publish({ ...before, loading: true, error: null, targetNotice: null })
    try {
      const isCurrent = (): boolean => mounted.current && ticket === sequence.current
      const chain = await resolveDirectoryAncestry(snapshot, entryId, isCurrent)
      if (chain && isCurrent()) publish(enterDirectory(before, chain, mode))
    } catch (error) {
      if (!mounted.current || ticket !== sequence.current) return
      const failure = requestError(error, 'Directory could not be loaded. Retry the request.')
      publish({ ...before, loading: false, error: failure })
    }
  }
  return {
    ...state,
    historical,
    currentDirectoryId: state.breadcrumbs.at(-1)?.id ?? null,
    navigateToDirectory: (id: string) => navigate(id),
    goBack: () => {
      const id = current.current.back.at(-1)
      return id ? navigate(id, 'back') : Promise.resolve()
    },
    goForward: () => {
      const id = current.current.forward.at(-1)
      return id ? navigate(id, 'forward') : Promise.resolve()
    },
    goUp: () => {
      const id = current.current.breadcrumbs.at(-2)?.id
      return id ? navigate(id) : Promise.resolve()
    },
    selectEntry: (id: string | null) =>
      publish({
        ...current.current,
        selectedEntryId: current.current.availability?.status === 'available' ? id : null
      }),
    refreshSnapshot
  }
}
