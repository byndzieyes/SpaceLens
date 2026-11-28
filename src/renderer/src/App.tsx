import { useMemo, useRef } from 'react'
import type { StorageDevice } from '../../shared/storage'
import { AppShell } from './components/layout/AppShell'
import { rankedExplorerTarget, type PageId } from './navigation'
import { useSnapshotSelections } from './features/snapshots/selection'
import { useSnapshotNavigation } from './features/snapshots/useSnapshotNavigation'
import { OverviewPage } from './pages/OverviewPage'
import { ExplorerPage } from './pages/ExplorerPage'
import { InsightsPage } from './pages/InsightsPage'
import { HistoryPage } from './pages/HistoryPage'
import { ComparisonMutations } from './features/comparison/selection'

function App(): React.JSX.Element {
  const selections = useSnapshotSelections()
  const driveCache = useRef<readonly StorageDevice[] | null>(null)
  const comparisonMutations = useMemo(() => new ComparisonMutations(), [])
  const {
    destination: { page: activePage, activation, target, arrival },
    viewOptions,
    navigate,
    navigateToSnapshot,
    consumeTarget
  } = useSnapshotNavigation(selections)
  const pages: Record<PageId, React.JSX.Element> = {
    overview: (
      <OverviewPage
        snapshots={selections}
        driveCache={driveCache}
        onOpenExplorer={() => navigate('explorer')}
        onOpenSnapshot={(view, scanId) =>
          navigateToSnapshot({ view, selection: { mode: 'explicit', scanId } })
        }
      />
    ),
    explorer: (
      <ExplorerPage
        key={activation}
        snapshots={viewOptions}
        target={target}
        arrival={arrival}
        onTargetConsumed={consumeTarget}
        onFollowLatest={() => navigate('explorer')}
      />
    ),
    insights: (
      <InsightsPage
        key={activation}
        snapshots={viewOptions}
        onOpenOverview={() => navigate('overview')}
        onFollowLatest={() => navigate('insights')}
        onOpenExplorer={(entry) =>
          navigateToSnapshot(rankedExplorerTarget(viewOptions.selection, entry))
        }
      />
    ),
    history: (
      <HistoryPage
        snapshots={selections}
        comparisonMutations={comparisonMutations}
        onCancelOpen={() => navigate('history')}
        onOpenEntry={(entry, onNotOpened) =>
          navigateToSnapshot(
            { view: 'explorer', selection: { mode: 'explicit', scanId: entry.scanId }, entry },
            onNotOpened
          )
        }
        onOpenSnapshot={(view, scanId, onNotOpened) =>
          navigateToSnapshot({ view, selection: { mode: 'explicit', scanId } }, onNotOpened)
        }
      />
    )
  }

  return (
    <AppShell activePage={activePage} onNavigate={navigate}>
      {pages[activePage]}
    </AppShell>
  )
}

export default App
