import { useEffect, useRef, type ReactNode } from 'react'
import { pageTitles, type PageId } from '../../navigation'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

interface AppShellProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
  children: ReactNode
  actions?: ReactNode
}

export function AppShell({
  activePage,
  onNavigate,
  children,
  actions
}: AppShellProps): React.JSX.Element {
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [activePage])

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-text-primary">
      <Sidebar activePage={activePage} onNavigate={onNavigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar title={pageTitles[activePage]} actions={actions} />
        <main
          ref={mainRef}
          aria-labelledby="page-title"
          tabIndex={0}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 focus-visible:-outline-offset-2 sm:p-6"
        >
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  )
}
