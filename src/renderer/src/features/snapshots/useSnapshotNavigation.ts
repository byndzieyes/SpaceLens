import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { followLatest } from '../../../../shared/snapshotSelection'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
import type { ScannerIpcErrorCode } from '../../../../shared/ipc'
import {
  isSnapshotView,
  type ExplorerTarget,
  type PageId,
  type SnapshotNavigationTarget
} from '../../navigation'
import type { SnapshotHandoff, SnapshotSelections, ViewSnapshotOptions } from './selection'

interface Destination {
  readonly page: PageId
  readonly activation: number
  readonly target?: ExplorerTarget
  readonly snapshot?: SnapshotNavigationTarget
  readonly handoff?: Promise<SnapshotHandoff | undefined>
}

interface PendingHandoff {
  readonly target: SnapshotNavigationTarget
  readonly source?: SnapshotView
}

export type SnapshotOpenFailure = (code?: ScannerIpcErrorCode) => void

export function useSnapshotNavigation(selections: SnapshotSelections): {
  destination: Destination
  viewOptions: ViewSnapshotOptions
  navigate: (page: PageId) => void
  navigateToSnapshot: (target: SnapshotNavigationTarget, onNotOpened?: SnapshotOpenFailure) => void
  consumeTarget: (target: ExplorerTarget) => void
} {
  const [destination, setDestination] = useState<Destination>({ page: 'overview', activation: 0 })
  const { page, snapshot, handoff } = destination
  const committedPage = useRef<PageId>('overview')
  const pending = useRef<PendingHandoff>(undefined)

  useLayoutEffect(() => {
    const previous = committedPage.current
    committedPage.current = page
    if (previous === page || !isSnapshotView(previous)) return
    const transition = pending.current
    if (transition?.source !== previous || transition.target !== snapshot)
      selections.release(previous)
  }, [page, selections, snapshot])

  useEffect(
    () => () => {
      pending.current = undefined
      selections.release('explorer')
      selections.release('insights')
    },
    [selections]
  )

  const abandon = (next: PageId, retainedSource?: SnapshotView): void => {
    const previous = pending.current
    pending.current = undefined
    if (!previous) return
    for (const view of [previous.source, previous.target.view]) {
      if (view && view !== next && view !== committedPage.current && view !== retainedSource)
        selections.release(view)
    }
  }
  const navigate = (page: PageId): void => {
    const cancelCurrentHandoff = pending.current?.target.view === page
    abandon(page)
    setDestination((current) =>
      current.page === page &&
      current.snapshot?.selection.mode !== 'explicit' &&
      !cancelCurrentHandoff
        ? current
        : { page, activation: current.activation + 1 }
    )
  }
  const navigateToSnapshot = (
    target: SnapshotNavigationTarget,
    onNotOpened?: SnapshotOpenFailure
  ): void => {
    const previous = committedPage.current
    const retained = pending.current?.source
    const source =
      retained && retained !== target.view
        ? retained
        : previous !== target.view && isSnapshotView(previous)
          ? previous
          : undefined
    abandon(target.view, source)
    const transition = { target, source }
    pending.current = transition
    const handoff = selections.select(target.view, target.selection).then((result) => {
      if (pending.current !== transition) {
        onNotOpened?.()
        return result
      }
      pending.current = undefined
      if (transition.source && transition.source !== committedPage.current)
        selections.release(transition.source)
      if (onNotOpened) {
        const valid =
          result?.status === 'resolved' &&
          (target.view !== 'explorer' ||
            target.selection.mode !== 'explicit' ||
            result.explorerSnapshot?.entries.scanId === target.selection.scanId)
        if (valid) open()
        else {
          selections.release(target.view)
          onNotOpened(result && 'error' in result ? result.error.code : 'SNAPSHOT_UNAVAILABLE')
        }
      }
      return result
    })
    const open = (): void => {
      setDestination((current) => ({
        page: target.view,
        activation: current.activation + 1,
        snapshot: target,
        handoff,
        target: target.view === 'explorer' ? target.entry : undefined
      }))
    }
    // History stays visible until adoption succeeds. Existing eager handoffs keep their behavior.
    if (!onNotOpened) open()
  }
  const consumeTarget = (opened: ExplorerTarget): void => {
    setDestination((current) =>
      current.page === 'explorer' && current.target === opened
        ? { ...current, target: undefined }
        : current
    )
  }
  return {
    destination,
    viewOptions: {
      controller: selections,
      selection: snapshot?.selection ?? followLatest,
      handoff
    },
    navigate,
    navigateToSnapshot,
    consumeTarget
  }
}
