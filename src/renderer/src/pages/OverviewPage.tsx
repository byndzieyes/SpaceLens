import { LayoutDashboard } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function OverviewPage(): React.JSX.Element {
  return (
    <PagePlaceholder
      title="Overview workspace"
      description="Your storage overview will appear here."
      icon={LayoutDashboard}
    />
  )
}
