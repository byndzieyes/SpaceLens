import type { ReactNode } from 'react'

interface TopbarProps {
  title: string
  actions?: ReactNode
}

export function Topbar({ title, actions }: TopbarProps): React.JSX.Element {
  return (
    <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-separator bg-surface/40 px-4 py-3 sm:px-6">
      <h1 id="page-title" className="min-w-0 text-lg font-semibold tracking-tight break-words">
        {title}
      </h1>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  )
}
