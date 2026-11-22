import { useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import type { ExplorerTarget, PageId } from './navigation'
import { OverviewPage } from './pages/OverviewPage'
import { ExplorerPage } from './pages/ExplorerPage'
import { InsightsPage } from './pages/InsightsPage'
import { HistoryPage } from './pages/HistoryPage'

function App(): React.JSX.Element {
  const [{ page: activePage, target }, setDestination] = useState<{
    page: PageId
    target?: ExplorerTarget
  }>({ page: 'overview' })
  const navigate = (page: PageId): void => setDestination({ page })
  const pages: Record<PageId, React.JSX.Element> = {
    overview: <OverviewPage onOpenExplorer={() => navigate('explorer')} />,
    explorer: (
      <ExplorerPage
        target={target}
        onTargetConsumed={(opened) => {
          setDestination((current) =>
            current.page === 'explorer' && current.target === opened
              ? { page: 'explorer' }
              : current
          )
        }}
      />
    ),
    insights: (
      <InsightsPage
        onOpenOverview={() => navigate('overview')}
        onOpenExplorer={(entry) => setDestination({ page: 'explorer', target: entry })}
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
