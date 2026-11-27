import type { EntryChangeKind } from '../../../../shared/comparison'

export const fileKinds = {
  added: { label: 'Added', color: '#86c9ac' },
  removed: { label: 'Removed', color: '#e49da9' },
  modified: { label: 'Modified', color: '#e5c486' },
  indeterminate: { label: 'Indeterminate', color: '#b7a8e8' },
  unchanged: { label: 'Unchanged', color: '#94a3b8' }
} satisfies Record<EntryChangeKind, { label: string; color: string }>

export const comparisonCounts = new Intl.NumberFormat('en-US')
export const comparisonSign = (value: number): string => (value < 0 ? '−' : value > 0 ? '+' : '')
