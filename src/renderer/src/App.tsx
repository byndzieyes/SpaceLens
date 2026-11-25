import { AppShell } from './components/layout/AppShell'
import { rankedExplorerTarget, type PageId } from './navigation'
import { useSnapshotSelections } from './features/snapshots/selection'
import { useSnapshotNavigation } from './features/snapshots/useSnapshotNavigation'
import { OverviewPage } from './pages/OverviewPage'
import { ExplorerPage } from './pages/ExplorerPage'
import { InsightsPage } from './pages/InsightsPage'
import { HistoryPage } from './pages/HistoryPage'

function App(): React.JSX.Element {
  const selections = useSnapshotSelections()
  const {
    destination: { page: activePage, activation, target },
    viewOptions,
    navigate,
    navigateToSnapshot,
    consumeTarget
  } = useSnapshotNavigation(selections)
  const pages: Record<PageId, React.JSX.Element> = {
    overview: <OverviewPage snapshots={selections} onOpenExplorer={() => navigate('explorer')} />,
    explorer: (
      <ExplorerPage
        key={activation}
        snapshots={viewOptions}
        target={target}
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
    history: <HistoryPage />
  }

  return (
    <AppShell activePage={activePage} onNavigate={navigate}>
      {pages[activePage]}
    </AppShell>
  )
}

export default App
