import {
  ChartColumn,
  FolderTree,
  HardDrive,
  History,
  LayoutDashboard,
  Settings
} from 'lucide-react'

const sections = [
  { label: 'Overview', icon: LayoutDashboard, current: true },
  { label: 'Explorer', icon: FolderTree, current: false },
  { label: 'Insights', icon: ChartColumn, current: false },
  { label: 'History', icon: History, current: false }
]

export function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-separator bg-surface md:w-56">
      <div className="flex h-16 shrink-0 items-center justify-center gap-3 border-b border-separator px-3 md:justify-start md:px-5">
        <HardDrive size={22} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="sr-only text-base font-semibold tracking-tight md:not-sr-only">
          SpaceLens
        </span>
      </div>

      <nav
        aria-label="Main navigation"
        aria-describedby="navigation-note"
        className="min-h-0 flex-1 overflow-y-auto p-2 md:p-3"
      >
        <p className="mb-3 hidden px-3 pt-3 text-xs font-medium tracking-wider text-text-secondary uppercase md:block">
          Workspace
        </p>
        <ul className="space-y-1">
          {sections.map(({ label, icon: Icon, current }) => (
            <li key={label}>
              <button
                type="button"
                disabled
                aria-current={current ? 'page' : undefined}
                title={`${label}${current ? ' (current page)' : ''} — navigation coming soon`}
                className={`flex min-h-10 w-full cursor-default items-center justify-center gap-3 rounded-md border px-2 py-2 text-sm md:justify-start md:px-3 ${
                  current
                    ? 'border-accent/20 bg-accent/10 font-medium text-accent'
                    : 'border-transparent text-text-secondary'
                }`}
              >
                <Icon size={18} className="shrink-0" aria-hidden="true" />
                <span className="sr-only md:not-sr-only">{label}</span>
              </button>
            </li>
          ))}
        </ul>
        <p id="navigation-note" className="mt-5 hidden px-3 text-xs text-text-secondary md:block">
          Navigation coming soon.
        </p>
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
