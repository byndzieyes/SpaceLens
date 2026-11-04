import { History } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function HistoryPage(): React.JSX.Element {
  return (
    <PagePlaceholder
      title="See how storage changes"
      description="Previous scans and comparisons between saved snapshots will appear here."
      icon={History}
    />
  )
}
