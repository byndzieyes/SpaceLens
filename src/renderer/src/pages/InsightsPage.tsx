import { ChartColumn } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function InsightsPage(): React.JSX.Element {
  return (
    <PagePlaceholder
      title="Understand your storage"
      description="Storage statistics and file type insights will appear here."
      icon={ChartColumn}
    />
  )
}
