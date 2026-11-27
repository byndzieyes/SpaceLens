import {
  followLatest,
  type SnapshotSelection,
  type SnapshotView
} from '../../shared/snapshotSelection'

export const pageTitles = {
  overview: 'Overview',
  explorer: 'Explorer',
  insights: 'Insights',
  history: 'History'
} as const

export type PageId = keyof typeof pageTitles

export interface ExplorerTarget {
  readonly scanId: string
  readonly entryId: string
  readonly parentId?: string | null
  readonly type: 'file' | 'directory'
}

export type SnapshotNavigationTarget =
  | {
      readonly view: 'explorer'
      readonly selection: SnapshotSelection
      readonly entry?: ExplorerTarget
    }
  | { readonly view: 'insights'; readonly selection: SnapshotSelection }

export const isSnapshotView = (page: PageId): page is SnapshotView =>
  page === 'explorer' || page === 'insights'

export function rankedExplorerTarget(
  selection: SnapshotSelection,
  entry: ExplorerTarget
): SnapshotNavigationTarget {
  return {
    view: 'explorer',
    selection:
      selection.mode === 'explicit' ? { mode: 'explicit', scanId: entry.scanId } : followLatest,
    entry
  }
}
