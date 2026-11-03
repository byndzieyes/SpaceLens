import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

interface AppShellProps {
  title: string
  children: ReactNode
  actions?: ReactNode
  footer?: ReactNode
}

export function AppShell({ title, children, actions, footer }: AppShellProps): React.JSX.Element {
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-text-primary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar title={title} actions={actions} />
        <main
          aria-labelledby="page-title"
          tabIndex={0}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 focus-visible:-outline-offset-2 sm:p-6"
        >
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
        {footer}
      </div>
    </div>
  )
}
