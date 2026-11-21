import { useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import type { PageId } from './navigation'
import { OverviewPage } from './pages/OverviewPage'
import { ExplorerPage } from './pages/ExplorerPage'
import { InsightsPage } from './pages/InsightsPage'
import { HistoryPage } from './pages/HistoryPage'

function App(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>('overview')
  const pages: Record<PageId, React.JSX.Element> = {
    overview: <OverviewPage onOpenExplorer={() => setActivePage('explorer')} />,
    explorer: <ExplorerPage />,
    insights: <InsightsPage onOpenOverview={() => setActivePage('overview')} />,
    history: <HistoryPage />
  }

  return (
    <AppShell activePage={activePage} onNavigate={setActivePage}>
      {pages[activePage]}
    </AppShell>
  )
}

export default App
