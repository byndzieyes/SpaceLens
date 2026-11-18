import { DirectoryContentsTable } from '../features/explorer/DirectoryContentsTable'
import { DetailsPanel } from '../features/explorer/DetailsPanel'
import { DirectoryTreemap } from '../features/explorer/DirectoryTreemap'
import { useExplorer } from '../features/explorer/useExplorer'
import { DirectoryTree } from '../features/explorer/DirectoryTree'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ArrowUp, FolderTree } from 'lucide-react'
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
  const { availability, error, loading } = explorer
  const snapshot = availability?.status === 'available' ? availability.snapshot : null
  const scanId = snapshot?.entries.scanId ?? null
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
            title="Back to the previous directory"
            className="px-3"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            disabled={explorer.loading || !explorer.forward.length}
            onClick={() => void explorer.goForward()}
            aria-label="Forward"
            title="Forward to the next directory in history"
            className="px-3"
          >
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            disabled={explorer.loading || explorer.breadcrumbs.length < 2}
            onClick={() => void explorer.goUp()}
            aria-label="Up"
            title="Up to the parent directory"
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
          ) : availability ? (
            <p className="text-sm text-text-secondary">No directory displayed</p>
          ) : null}
        </div>
        <p
          id="explorer-navigation-notice"
          className="w-full text-xs text-text-secondary [overflow-wrap:anywhere]"
        >
          {snapshot
            ? explorer.breadcrumbs.at(-1)?.path
            : availability?.status === 'summary-only'
              ? availability.unavailable.reason === 'limit-exceeded'
                ? 'Summary only. The temporary snapshot storage limit was reached.'
                : 'Summary only. Filesystem entries could not be retained.'
              : availability?.status === 'missing'
                ? 'No published snapshot yet. Complete a scan in Overview to browse its retained entries.'
                : null}
        </p>
      </div>

      {loading && (
        <p role="status" className="text-sm text-text-secondary">
          {availability ? 'Updating Explorer…' : 'Loading snapshot…'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-error [overflow-wrap:anywhere]">
          {error.code}: {error.message}
          {(!availability ||
            error.code === 'SNAPSHOT_EXPIRED' ||
            error.code === 'SNAPSHOT_UNAVAILABLE') &&
            ' Use Refresh snapshot to check which results are available.'}
        </p>
      )}
      {snapshot?.incomplete && (
        <p className="text-warning">Incomplete snapshot: known sizes may be partial.</p>
      )}
      {availability?.status === 'available' && availability.unavailable && (
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
          {snapshot ? (
            <DirectoryTree
              snapshot={snapshot}
              currentDirectoryId={explorer.currentDirectoryId}
              navigationDisabled={explorer.loading}
              onNavigate={explorer.navigateToDirectory}
            />
          ) : availability ? (
            <div className="min-h-40 flex-1 overflow-y-auto pt-6 md:max-h-96">
              <FolderTree size={24} className="mb-4 text-text-secondary" aria-hidden="true" />
              <p className="text-sm font-medium">No directories displayed</p>
              <p className="mt-2 text-sm text-text-secondary">
                An available snapshot is needed to browse directories.
              </p>
            </div>
          ) : null}
        </ExplorerPanel>

        <ExplorerPanel id="explorer-treemap-title" title="Treemap">
          {availability && (
            <DirectoryTreemap
              scanId={scanId}
              directory={explorer.breadcrumbs.at(-1) ?? null}
              selectedEntryId={explorer.selectedEntryId}
              onSelect={explorer.selectEntry}
              onNavigate={explorer.navigateToDirectory}
              disabled={explorer.loading}
            />
          )}
        </ExplorerPanel>

        <ExplorerPanel
          id="explorer-details-title"
          title="Details"
          className="md:col-span-2 xl:col-span-1"
        >
          {availability && (
            <DetailsPanel scanId={scanId} selectedEntryId={explorer.selectedEntryId} />
          )}
        </ExplorerPanel>
      </div>

      <ExplorerPanel id="explorer-contents-title" title="Directory Contents">
        {availability && (
          <DirectoryContentsTable
            scanId={scanId}
            directoryId={explorer.currentDirectoryId}
            selectedEntryId={explorer.selectedEntryId}
            disabled={explorer.loading}
            onSelect={explorer.selectEntry}
            onNavigate={explorer.navigateToDirectory}
          />
        )}
      </ExplorerPanel>
    </div>
  )
}
