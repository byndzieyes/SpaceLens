import { useExplorer } from '../features/explorer/useExplorer'
import { DirectoryTree } from '../features/explorer/DirectoryTree'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ArrowUp, File, FolderTree, LayoutGrid } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'

function ExplorerPanel({
  id,
  title,
  className = '',
  children
}: {
  id: string
  title: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Card aria-labelledby={id} className={`flex min-w-0 flex-col ${className}`}>
      <h3 id={id} className="border-b border-separator pb-4 text-sm font-semibold">
        {title}
      </h3>
      {children}
    </Card>
  )
}

export function ExplorerPage(): React.JSX.Element {
  const explorer = useExplorer()
  return (
    <div className="min-w-0 space-y-5">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Storage Explorer</h2>
        <p className="text-sm text-text-secondary">
          Explore directories, storage usage and item details.
        </p>
      </header>

      <div
        role="group"
        aria-label="Directory navigation"
        aria-describedby="explorer-navigation-notice"
        className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3"
      >
        <div className="flex shrink-0 gap-1">
          <Button
            variant="secondary"
            disabled={explorer.loading || !explorer.back.length}
            onClick={() => void explorer.goBack()}
            aria-label="Back"
            title="Back — not available yet"
            className="px-3"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            disabled={explorer.loading || !explorer.forward.length}
            onClick={() => void explorer.goForward()}
            aria-label="Forward"
            title="Forward — not available yet"
            className="px-3"
          >
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            disabled={explorer.loading || explorer.breadcrumbs.length < 2}
            onClick={() => void explorer.goUp()}
            aria-label="Up"
            title="Up — not available yet"
            className="px-3"
          >
            <ArrowUp size={16} aria-hidden="true" />
          </Button>
        </div>
        <div
          aria-label="Directory path"
          className="min-w-0 flex-1 basis-48 rounded-md border border-separator bg-background/50 px-3 py-2"
        >
          {explorer.breadcrumbs.length ? (
            <nav aria-label="Breadcrumb" className="overflow-x-auto">
              <ol className="flex items-center gap-2 whitespace-nowrap">
                {explorer.breadcrumbs.map((entry, index) => (
                  <li key={entry.id}>
                    {index > 0 && <span aria-hidden="true"> / </span>}
                    {index === explorer.breadcrumbs.length - 1 ? (
                      <span aria-current="page" title={entry.path}>
                        {entry.name || entry.path}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={explorer.loading}
                        className="text-accent hover:underline"
                        onClick={() => void explorer.navigateToDirectory(entry.id)}
                        title={entry.path}
                      >
                        {entry.name || entry.path}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          ) : (
            <p className="text-sm text-text-secondary">No directory displayed</p>
          )}
        </div>
        <p
          id="explorer-navigation-notice"
          className="w-full text-xs text-text-secondary [overflow-wrap:anywhere]"
        >
          {explorer.loading
            ? 'Loading snapshot?'
            : explorer.availability?.status === 'available'
              ? explorer.breadcrumbs.at(-1)?.path
              : explorer.availability?.status === 'summary-only'
                ? 'Summary only: this scan has no retained entries.'
                : 'No snapshot available. Complete a scan in Overview.'}
        </p>
      </div>

      {explorer.error && (
        <p role="alert" className="text-error">
          {explorer.error.code}: {explorer.error.message}
        </p>
      )}
      {explorer.availability?.status === 'available' &&
        explorer.availability.snapshot.incomplete && (
          <p className="text-warning">Incomplete snapshot: known sizes may be partial.</p>
        )}
      {explorer.availability?.status === 'available' && explorer.availability.unavailable && (
        <p className="text-text-secondary">
          A newer scan has summary-only results. Browsing the retained snapshot.
        </p>
      )}
      <Button
        variant="secondary"
        disabled={explorer.loading}
        onClick={() => void explorer.refreshSnapshot()}
      >
        Refresh snapshot
      </Button>
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-[11rem_minmax(0,1fr)] xl:grid-cols-[minmax(11rem,1fr)_minmax(0,2fr)_minmax(12rem,1fr)]">
        <ExplorerPanel id="explorer-tree-title" title="Directory Tree">
          {explorer.availability?.status === 'available' ? (
            <DirectoryTree
              snapshot={explorer.availability.snapshot}
              currentDirectoryId={explorer.currentDirectoryId}
              navigationDisabled={explorer.loading}
              onNavigate={explorer.navigateToDirectory}
            />
          ) : (
            <div className="min-h-40 flex-1 overflow-y-auto pt-6 md:max-h-96">
              <FolderTree size={24} className="mb-4 text-text-secondary" aria-hidden="true" />
              <p className="text-sm font-medium">No directories displayed</p>
              <p className="mt-2 text-sm text-text-secondary">
                An available snapshot is needed to browse directories.
              </p>
            </div>
          )}
        </ExplorerPanel>

        <ExplorerPanel id="explorer-treemap-title" title="Treemap">
          <div className="relative mt-4 flex min-h-64 min-w-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background/40 p-5 sm:min-h-80">
            <div className="max-w-xs text-center">
              <LayoutGrid size={32} className="mx-auto mb-4 text-accent" aria-hidden="true" />
              <p className="font-medium">Your storage, at a glance</p>
              <p className="mt-2 text-sm text-text-secondary">
                Scan data is not displayed in Explorer yet.
              </p>
              <p className="mt-2 text-xs text-text-secondary">
                This area will show how files and folders use space.
              </p>
            </div>
          </div>
        </ExplorerPanel>

        <ExplorerPanel
          id="explorer-details-title"
          title="Details"
          className="md:col-span-2 xl:col-span-1"
        >
          <div className="min-w-0 space-y-5 pt-6 [overflow-wrap:anywhere]">
            <div className="flex min-w-0 items-start gap-3">
              <div className="shrink-0 rounded-lg bg-surface-elevated p-2 text-text-secondary">
                <File size={22} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="font-medium">No item selected</p>
                <p className="mt-1 text-sm text-text-secondary">
                  File and folder details will appear here.
                </p>
              </div>
            </div>
            <dl className="space-y-3 text-xs">
              {['Type', 'Size', 'Modified'].map((label) => (
                <div
                  key={label}
                  className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b border-separator pb-3"
                >
                  <dt className="text-text-secondary">{label}</dt>
                  <dd aria-label="Not available" className="min-w-0">
                    —
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </ExplorerPanel>
      </div>

      <ExplorerPanel id="explorer-contents-title" title="Directory Contents">
        <div
          role="region"
          aria-label="Directory contents table"
          tabIndex={0}
          className="relative min-w-0 overflow-x-auto focus-visible:-outline-offset-2"
        >
          <table
            aria-describedby="explorer-contents-empty"
            className="w-full min-w-[26rem] border-collapse text-left text-sm"
          >
            <caption className="sr-only">Files and directories in the displayed directory</caption>
            <thead className="border-b border-separator text-xs text-text-secondary">
              <tr>
                <th scope="col" className="py-3 pr-4 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Type
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Size
                </th>
                <th scope="col" className="py-3 pl-4 font-medium">
                  Modified
                </th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <p id="explorer-contents-empty" className="py-10 text-center text-sm text-text-secondary">
          No directory contents to display
        </p>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-separator pt-4">
          <p className="text-xs text-text-secondary">Directory paging is not available yet.</p>
          <div className="flex gap-2" role="group" aria-label="Directory contents pagination">
            <Button variant="secondary" disabled aria-label="Previous page">
              Previous
            </Button>
            <Button variant="secondary" disabled aria-label="Next page">
              Next
            </Button>
          </div>
        </footer>
      </ExplorerPanel>
    </div>
  )
}
