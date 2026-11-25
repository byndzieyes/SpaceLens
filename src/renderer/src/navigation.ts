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
  readonly parentId: string
  readonly type: 'file' | 'directory'
}
import type { SnapshotSelection, SnapshotView } from '../../shared/snapshotSelection'

export type SnapshotNavigationTarget =
  | {
      readonly view: 'explorer'
      readonly selection: SnapshotSelection
      readonly entry?: ExplorerTarget
    }
  | { readonly view: 'insights'; readonly selection: SnapshotSelection }

export const isSnapshotView = (page: PageId): page is SnapshotView =>
  page === 'explorer' || page === 'insights'
