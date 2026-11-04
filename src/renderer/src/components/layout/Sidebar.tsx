import {
  ChartColumn,
  FolderTree,
  HardDrive,
  History,
  LayoutDashboard,
  Settings,
  type LucideIcon
} from 'lucide-react'
import { pageTitles, type PageId } from '../../navigation'

const sections: ReadonlyArray<{ id: PageId; icon: LucideIcon }> = [
  { id: 'overview', icon: LayoutDashboard },
  { id: 'explorer', icon: FolderTree },
  { id: 'insights', icon: ChartColumn },
  { id: 'history', icon: History }
]

interface SidebarProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
}

export function Sidebar({ activePage, onNavigate }: SidebarProps): React.JSX.Element {
  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-separator bg-surface md:w-56">
      <div className="flex h-16 shrink-0 items-center justify-center gap-3 border-b border-separator px-3 md:justify-start md:px-5">
        <HardDrive size={22} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="sr-only text-base font-semibold tracking-tight md:not-sr-only">
          SpaceLens
        </span>
      </div>

      <nav aria-label="Main navigation" className="min-h-0 flex-1 overflow-y-auto p-2 md:p-3">
        <p className="mb-3 hidden px-3 pt-3 text-xs font-medium tracking-wider text-text-secondary uppercase md:block">
          Workspace
        </p>
        <ul className="space-y-1">
          {sections.map(({ id, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => onNavigate(id)}
                aria-current={activePage === id ? 'page' : undefined}
                title={pageTitles[id]}
                className={`flex min-h-10 w-full cursor-pointer items-center justify-center gap-3 rounded-md border px-2 py-2 text-sm transition-colors duration-150 motion-reduce:transition-none md:justify-start md:px-3 ${
                  activePage === id
                    ? 'border-accent/20 bg-accent/10 font-medium text-accent hover:bg-accent/15 active:bg-accent/20'
                    : 'border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active'
                }`}
              >
                <Icon size={18} className="shrink-0" aria-hidden="true" />
                <span className="sr-only md:not-sr-only">{pageTitles[id]}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-separator p-2 md:p-3">
        <button
          type="button"
          disabled
          title="Settings — coming soon"
          aria-label="Settings — coming soon"
          className="flex min-h-10 w-full cursor-default items-center justify-center gap-3 rounded-md px-2 py-2 text-sm text-text-secondary md:justify-start md:px-3"
        >
          <Settings size={18} className="shrink-0" aria-hidden="true" />
          <span className="sr-only md:not-sr-only">Settings</span>
        </button>
      </div>
    </aside>
  )
}
