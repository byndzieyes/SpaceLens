import type { RefObject } from 'react'
import { ChevronRight, FileDiff, FolderSearch, FolderTree } from 'lucide-react'
import type {
  ComparisonDirectoryChange,
  ComparisonDirectoryObservation,
  ComparisonEntryReference,
  ComparisonFileChange,
  ComparisonPair,
  ComparisonPathObservation,
  ComparisonSide,
  EntryChangeKind,
  FileChangeClassification
} from '../../../../shared/comparison'
import { RowActionsMenu, type RowAction } from '../../components/ui/RowActionsMenu'
import { ComparisonBytes } from './ComparisonBytes'
import { comparisonCounts as counts, fileKinds } from './changeDisplay'
import { sideLabels } from './draft'

const fileReasons = {
  'confirmed-absence': 'Confirmed absence',
  'type-replacement': 'Type replacement',
  'size-changed': 'Size changed',
  'modified-time-changed': 'Modified time changed',
  'size-and-modified-time-changed': 'Size and modified time changed',
  'metadata-equal': 'Available size and timestamp match',
  'unknown-presence': 'Presence uncertain',
  'unknown-entry-type': 'Entry type uncertain',
  'unknown-metadata': 'File metadata incomplete'
} satisfies Record<FileChangeClassification['reason'], string>

export type OpenComparisonEntry = (side: ComparisonSide, entry: ComparisonEntryReference) => void
export type ScopeChange = (path: string, view: 'files' | 'directories') => void

export function ChangePath({ path }: { path: string }): React.JSX.Element {
  if (path.length <= 28)
    return (
      <span className="block whitespace-pre-wrap [overflow-wrap:anywhere]">
        {path || 'Comparison root'}
      </span>
    )
  return (
    <details className="group min-w-0">
      <summary
        title={path}
        className="flex min-w-0 cursor-pointer list-none items-center gap-1 hover:text-accent [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0 truncate whitespace-pre">{path}</span>
        <ChevronRight size={13} aria-hidden="true" className="shrink-0 group-open:rotate-90" />
      </summary>
      <span className="mt-1 block text-xs break-all whitespace-pre-wrap text-text-secondary select-text">
        {path}
      </span>
    </details>
  )
}

function Classification({ kind }: { kind: EntryChangeKind }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: fileKinds[kind].color }}
      />
      {fileKinds[kind].label}
    </span>
  )
}

function FileSize({ observation }: { observation: ComparisonPathObservation }): React.JSX.Element {
  if (observation.presence === 'present' && observation.entry.type === 'file')
    return <ComparisonBytes value={observation.entry.sizeBytes} unknown="Unknown" />
  return (
    <span className="text-text-secondary">
      {observation.presence === 'present'
        ? 'Not a file'
        : observation.presence === 'absent'
          ? 'Absent'
          : 'Unknown'}
    </span>
  )
}

function DirectorySize({
  observation
}: {
  observation: ComparisonDirectoryObservation
}): React.JSX.Element {
  if (observation.presence === 'present')
    return <ComparisonBytes value={observation.observedBytes} unknown="Unknown" />
  return (
    <span className="text-text-secondary">
      {observation.presence === 'absent' ? 'Absent' : 'Unknown'}
    </span>
  )
}

interface ChangeActionsProps {
  row: ComparisonFileChange | ComparisonDirectoryChange
  pair: ComparisonPair
  onOpen: OpenComparisonEntry
  onScope: ScopeChange
  fallbackFocus: RefObject<HTMLElement | null>
}

export function ChangeActions({
  row,
  pair,
  onOpen,
  onScope,
  fallbackFocus
}: ChangeActionsProps): React.JSX.Element | null {
  const directory = 'observedDeltaBytes' in row
  const items: RowAction[] = []
  for (const side of ['baseline', 'target'] as const) {
    const observation = row[side]
    const scanId = side === 'baseline' ? pair.baselineScanId : pair.targetScanId
    if (
      observation.presence === 'present' &&
      observation.entry.type === (directory ? 'directory' : 'file') &&
      observation.entry.scanId === scanId
    ) {
      const { entry } = observation
      items.push({
        label: `Open ${sideLabels[side]} in Explorer`,
        icon: <FolderTree size={15} aria-hidden="true" className="shrink-0" />,
        onSelect: () => onOpen(side, entry)
      })
    }
  }
  if (directory && items.length > 0) {
    items.push(
      {
        label: 'View file changes',
        icon: <FileDiff size={15} aria-hidden="true" className="shrink-0" />,
        onSelect: () => onScope(row.relativePath, 'files')
      },
      {
        label: 'Inspect subtree',
        icon: <FolderSearch size={15} aria-hidden="true" className="shrink-0" />,
        onSelect: () => onScope(row.relativePath, 'directories')
      }
    )
  }
  if (!items.length) return null
  return (
    <RowActionsMenu
      label={`Actions for ${row.relativePath || 'comparison root'}`}
      menuLabel="Change actions"
      items={items}
      fallbackFocus={fallbackFocus}
    />
  )
}

function DirectoryCounts({ row }: { row: ComparisonDirectoryChange }): React.JSX.Element {
  const { counts: files, unknownDeltaCount } = row.subtreeFiles
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap gap-x-2 tabular-nums">
        <span>Added {counts.format(files.added)}</span>
        <span>Removed {counts.format(files.removed)}</span>
        <span>Modified {counts.format(files.modified)}</span>
      </div>
      <details>
        <summary className="cursor-pointer text-text-secondary hover:text-accent">
          More file counts
        </summary>
        <div className="mt-1 space-y-0.5 tabular-nums">
          <p>Unchanged {counts.format(files.unchanged)}</p>
          <p>Indeterminate {counts.format(files.indeterminate)}</p>
          <p>Unknown byte deltas {counts.format(unknownDeltaCount)}</p>
        </div>
      </details>
      {row.typeReplacement && <p className="text-text-secondary">Type replacement</p>}
      {row.uncertain && <p className="text-warning">Uncertain coverage or changes</p>}
    </div>
  )
}

export function ChangeTable({
  view,
  rows,
  ...actions
}: Omit<ChangeActionsProps, 'row'> & {
  view: 'files' | 'directories'
  rows: readonly (ComparisonFileChange | ComparisonDirectoryChange)[]
}): React.JSX.Element {
  const title = view === 'files' ? 'File changes' : 'Directory changes'
  const bytes = 'px-2 py-2.5 text-right whitespace-nowrap tabular-nums'
  return (
    <div className="@container min-w-0 space-y-1.5">
      <p className="text-xs text-text-secondary @min-[42rem]:hidden">
        Scroll sideways to see all columns.
      </p>
      <div
        role="region"
        aria-label={`${title} table scroll area`}
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-separator focus-visible:-outline-offset-2"
      >
        <table className="w-full min-w-[42rem] table-fixed text-left text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="bg-surface-elevated text-xs text-text-secondary">
            <tr>
              <th scope="col" className="w-[22%] px-3 py-2.5 font-medium">
                Relative path
              </th>
              <th scope="col" className="w-[14%] px-2 py-2.5 font-medium">
                Status
              </th>
              <th scope="col" className="w-[11%] px-2 py-2.5 text-right font-medium">
                Baseline
              </th>
              <th scope="col" className="w-[11%] px-2 py-2.5 text-right font-medium">
                Target
              </th>
              <th scope="col" className="w-[11%] px-2 py-2.5 text-right font-medium">
                Byte delta
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                {view === 'files' ? 'Reason' : 'Subtree files'}
              </th>
              <th
                scope="col"
                className="sticky right-0 z-10 w-14 border-l border-separator bg-surface-elevated p-2 text-center font-medium"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-separator border-t border-separator align-top">
            {rows.map((row) => {
              const directory = 'observedDeltaBytes' in row
              return (
                <tr key={row.relativePath} className="hover:bg-surface-hover/40">
                  <th scope="row" className="min-w-0 px-3 py-2.5 font-medium">
                    <ChangePath path={row.relativePath} />
                  </th>
                  <td className="px-2 py-2.5">
                    <Classification kind={row.kind} />
                  </td>
                  <td className={bytes}>
                    {directory ? (
                      <DirectorySize observation={row.baseline} />
                    ) : (
                      <FileSize observation={row.baseline} />
                    )}
                  </td>
                  <td className={bytes}>
                    {directory ? (
                      <DirectorySize observation={row.target} />
                    ) : (
                      <FileSize observation={row.target} />
                    )}
                  </td>
                  <td className={bytes}>
                    <ComparisonBytes
                      value={directory ? row.observedDeltaBytes : row.deltaBytes}
                      signed
                      unknown="Unknown"
                    />
                  </td>
                  <td className="px-3 py-2.5 text-xs text-text-secondary">
                    {directory ? <DirectoryCounts row={row} /> : fileReasons[row.reason]}
                  </td>
                  <td className="sticky right-0 z-10 border-l border-separator bg-surface p-1.5 text-center">
                    <ChangeActions row={row} {...actions} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
