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
