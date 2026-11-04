export const pageTitles = {
  overview: 'Overview',
  explorer: 'Explorer',
  insights: 'Insights',
  history: 'History'
} as const

export type PageId = keyof typeof pageTitles
