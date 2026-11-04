import type { LucideIcon } from 'lucide-react'
import { Card } from '../components/ui/Card'

interface PagePlaceholderProps {
  title: string
  description: string
  icon: LucideIcon
}

export function PagePlaceholder({
  title,
  description,
  icon: Icon
}: PagePlaceholderProps): React.JSX.Element {
  return (
    <Card
      aria-labelledby="placeholder-title"
      className="flex min-h-64 flex-col items-center justify-center gap-3 border-dashed text-center"
    >
      <Icon size={24} className="text-text-secondary" aria-hidden="true" />
      <h2 id="placeholder-title" className="text-base font-medium">
        {title}
      </h2>
      <p className="max-w-sm text-sm text-text-secondary">{description}</p>
    </Card>
  )
}
