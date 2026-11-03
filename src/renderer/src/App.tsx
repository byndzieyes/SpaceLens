import { LayoutDashboard } from 'lucide-react'
import { AppInfoFooter } from './components/AppInfoFooter'
import { AppShell } from './components/layout/AppShell'
import { Card } from './components/ui/Card'

function App(): React.JSX.Element {
  return (
    <AppShell title="Overview" footer={<AppInfoFooter />}>
      <Card
        aria-labelledby="overview-placeholder-title"
        className="flex min-h-64 flex-col items-center justify-center gap-3 border-dashed text-center"
      >
        <LayoutDashboard size={24} className="text-text-secondary" aria-hidden="true" />
        <h2 id="overview-placeholder-title" className="text-base font-medium">
          Overview workspace
        </h2>
        <p className="max-w-sm text-sm text-text-secondary">Page content will appear here.</p>
      </Card>
    </AppShell>
  )
}

export default App
