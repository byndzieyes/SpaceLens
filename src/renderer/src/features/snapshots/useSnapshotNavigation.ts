import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { followLatest } from '../../../../shared/snapshotSelection'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
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

export function useSnapshotNavigation(selections: SnapshotSelections): {
  destination: Destination
  viewOptions: ViewSnapshotOptions
  navigate: (page: PageId) => void
  navigateToSnapshot: (target: SnapshotNavigationTarget) => void
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
  const navigateToSnapshot = (target: SnapshotNavigationTarget): void => {
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
    // Open the shell immediately. The destination waits for adoption before starting its reads.
    const handoff = selections.select(target.view, target.selection).then((result) => {
      if (pending.current === transition) {
        pending.current = undefined
        if (transition.source && transition.source !== committedPage.current)
          selections.release(transition.source)
      }
      return result
    })
    setDestination((current) => ({
      page: target.view,
      activation: current.activation + 1,
      snapshot: target,
      handoff,
      target: target.view === 'explorer' ? target.entry : undefined
    }))
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
