import { DirectoryContentsTable } from '../features/explorer/DirectoryContentsTable'
import { DetailsPanel } from '../features/explorer/DetailsPanel'
import { DirectoryTreemap } from '../features/explorer/DirectoryTreemap'
import { useExplorer } from '../features/explorer/useExplorer'
import { DirectoryTree } from '../features/explorer/DirectoryTree'
import { isStaleSnapshotError } from '../features/explorer/data'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ArrowUp, FolderTree } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { formatScanDate } from '../lib/scanDisplay'
import type { ExplorerTarget } from '../navigation'
import type { ViewSnapshotOptions } from '../features/snapshots/selection'

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

export function ExplorerPage({
  target,
  onTargetConsumed,
  snapshots,
  onFollowLatest
}: {
  target?: ExplorerTarget
  onTargetConsumed?: (target: ExplorerTarget) => void
  snapshots?: ViewSnapshotOptions
  onFollowLatest?: () => void
} = {}): React.JSX.Element {
  const explorer = useExplorer(target, onTargetConsumed, snapshots)
  const { availability, error, loading } = explorer
  const snapshot = availability?.status === 'available' ? availability.snapshot : null
  const scanId = snapshot?.entries.scanId ?? null
  const explicit = snapshots?.selection.mode === 'explicit'
  const breadcrumb = useRef<HTMLElement>(null)
  const refreshControl = useRef<HTMLButtonElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    if (target || explicit) title.current?.focus({ preventScroll: true })
  }, [explicit, target])
  const refresh = (): void => {
    if (loading) return
    refreshControl.current?.focus()
    void explorer.refreshSnapshot()
  }
  const navigation = [
    { label: 'Back', disabled: !explorer.back.length, activate: explorer.goBack, Icon: ArrowLeft },
    {
      label: 'Forward',
      disabled: !explorer.forward.length,
      activate: explorer.goForward,
      Icon: ArrowRight
    },
    {
      label: 'Up',
      disabled: explorer.breadcrumbs.length < 2,
      activate: explorer.goUp,
      Icon: ArrowUp
    }
  ]
  return (
    <div className="min-w-0 space-y-5">
      <header className="space-y-2">
        <h2 ref={title} tabIndex={-1} className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Storage Explorer
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{explicit ? 'Explicit snapshot' : 'Following Latest'}</Badge>
          {snapshot && explorer.historical && <Badge>Historical snapshot</Badge>}
          {explicit && onFollowLatest && (
            <Button
              variant="secondary"
              onClick={(event) => {
                event.currentTarget.closest('main')?.focus({ preventScroll: true })
                onFollowLatest()
              }}
            >
              Follow Latest
            </Button>
          )}
        </div>
        {snapshot && (
          <dl aria-label="Snapshot details" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div className="min-w-0">
              <dt className="text-xs text-text-secondary">Snapshot root</dt>
              <dd className="[overflow-wrap:anywhere]">{snapshot.root.path}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Completed</dt>
              <dd>
                <time dateTime={snapshot.completedAt}>{formatScanDate(snapshot.completedAt)}</time>
              </dd>
            </div>
          </dl>
        )}
      </header>

      <div
        role="group"
        aria-label="Directory navigation"
        aria-describedby="explorer-navigation-notice"
        className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3"
      >
        <div className="flex max-w-full flex-wrap gap-1">
          {navigation.map(({ label, disabled, activate, Icon }) => (
            <Button
              key={label}
              variant="secondary"
              aria-disabled={loading || disabled}
              tabIndex={loading || disabled ? -1 : undefined}
              onClick={() => {
                if (!loading && !disabled) void activate()
              }}
              aria-label={label}
              title={label}
              className="px-3 aria-disabled:opacity-50"
            >
              <Icon size={16} aria-hidden="true" />
            </Button>
          ))}
          <Button
            ref={refreshControl}
            variant="secondary"
            aria-disabled={loading}
            tabIndex={loading ? -1 : undefined}
            className="aria-disabled:opacity-50"
            onClick={refresh}
          >
            Refresh snapshot
          </Button>
        </div>
        <div
          aria-label="Directory path"
          className="min-w-0 flex-1 basis-48 rounded-md border border-separator bg-background/50 px-3 py-2"
        >
          {explorer.breadcrumbs.length ? (
            <nav
              ref={breadcrumb}
              aria-label="Breadcrumb"
              tabIndex={-1}
              className="max-h-[20em] overflow-y-auto rounded-sm scrollbar-none focus-visible:-outline-offset-2"
            >
              <ol className="flex flex-wrap items-baseline gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
                {explorer.breadcrumbs.map((entry, index) => (
                  <li key={entry.id} className="flex min-w-0 items-baseline gap-2">
                    {index > 0 && (
                      <span aria-hidden="true" className="text-text-secondary">
                        /
                      </span>
                    )}
                    {index === explorer.breadcrumbs.length - 1 ? (
                      <span
                        aria-current="page"
                        title={entry.path}
                        className="min-w-0 font-semibold"
                      >
                        {entry.name || entry.path}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={explorer.loading}
                        className="min-w-0 rounded-sm px-1 text-left text-accent hover:underline focus-visible:-outline-offset-2"
                        onClick={(event) => {
                          if (event.currentTarget === document.activeElement)
                            breadcrumb.current?.focus({ preventScroll: true })
                          void explorer.navigateToDirectory(entry.id)
                        }}
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
            : availability?.status === 'missing'
              ? 'No published snapshot yet. Complete a scan in Overview to browse its entries.'
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
          {(!availability || isStaleSnapshotError(error.code)) &&
            (explicit
              ? ' Use Refresh snapshot to retry this selection.'
              : ' Use Refresh snapshot to check which results are available.')}
        </p>
      )}
      {explorer.targetNotice && (
        <p role="alert" className="text-warning [overflow-wrap:anywhere]">
          {explorer.targetNotice}
        </p>
      )}
      {snapshot?.incomplete && (
        <p className="text-warning">Incomplete snapshot: known sizes may be partial.</p>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)_minmax(12rem,1fr)]">
        <ExplorerPanel id="explorer-tree-title" title="Directory Tree">
          {snapshot ? (
            <DirectoryTree
              snapshot={snapshot}
              currentDirectoryId={explorer.currentDirectoryId}
              activePath={explorer.revealPath ? explorer.breadcrumbs : undefined}
              navigationDisabled={explorer.loading}
              onNavigate={explorer.navigateToDirectory}
              onRefresh={refresh}
            />
          ) : availability ? (
            <div className="min-h-40 flex-1 overflow-y-auto pt-6 scrollbar-none md:max-h-96">
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
              onRefresh={refresh}
            />
          )}
        </ExplorerPanel>

        <ExplorerPanel
          id="explorer-details-title"
          title="Details"
          className="md:col-span-2 xl:col-span-1"
        >
          {availability && (
            <DetailsPanel
              scanId={scanId}
              selectedEntryId={explorer.selectedEntryId}
              disabled={loading}
              initialEntry={explorer.fileArrival?.entry}
              onRefresh={refresh}
            />
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
            initialPage={explorer.fileArrival?.contents}
            onSelect={explorer.selectEntry}
            onNavigate={explorer.navigateToDirectory}
            onRefresh={refresh}
          />
        )}
      </ExplorerPanel>
    </div>
  )
}
