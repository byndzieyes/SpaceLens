import { useState, type ComponentType } from 'react'
import { AppShell } from './components/layout/AppShell'
import type { PageId } from './navigation'
import { OverviewPage } from './pages/OverviewPage'
import { ExplorerPage } from './pages/ExplorerPage'
import { InsightsPage } from './pages/InsightsPage'
import { HistoryPage } from './pages/HistoryPage'

const pageComponents: Record<PageId, ComponentType> = {
  overview: OverviewPage,
  explorer: ExplorerPage,
  insights: InsightsPage,
  history: HistoryPage
}

function App(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>('overview')
  const Page = pageComponents[activePage]

  return (
    <AppShell activePage={activePage} onNavigate={setActivePage}>
      <Page />
    </AppShell>
  )
}

export default App
