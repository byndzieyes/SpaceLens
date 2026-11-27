import { StrictMode } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type {
  ComparisonFileSummary,
  ComparisonSummary,
  CompatiblePair
} from '../src/shared/comparison'
import type { SpaceLensAPI } from '../src/shared/ipc'
import { ComparisonDashboard } from '../src/renderer/src/features/comparison/ComparisonDashboard'
import { ComparisonSummaryView } from '../src/renderer/src/features/comparison/ComparisonSummaryView'

const pair = { baselineScanId: 'baseline', targetScanId: 'target' }
const compatible: CompatiblePair = {
  pair,
  status: 'compatible',
  normalizedRoot: '/media',
  pathStyle: 'posix',
  coverage: { baseline: 'complete', target: 'complete' }
}
const empty: ComparisonFileSummary = {
  counts: { added: 0, removed: 0, modified: 0, indeterminate: 0, unchanged: 0 },
  totalCount: 0,
  knownDeltaCount: 0,
  unknownDeltaCount: 0,
  positiveDeltaBytes: 0,
  negativeDeltaBytes: 0,
  netKnownDeltaBytes: 0,
  confirmedKnownDeltaBytes: 0,
  confirmedUnknownDeltaCount: 0
}

function fixture({
  before = 10000,
  after = 14000,
  files = empty,
  compatibility = compatible,
  baselineCount = 8,
  targetCount = 9,
  beforeDirectories = 5,
  afterDirectories = 3
}: {
  before?: number
  after?: number
  baselineCount?: number
  targetCount?: number
  beforeDirectories?: number
  afterDirectories?: number
  files?: ComparisonFileSummary
  compatibility?: CompatiblePair
} = {}): ComparisonSummary {
  const scan = (
    id: string,
    totalBytes: number,
    fileCount: number,
    directoryCount: number
  ): ComparisonSummary['baseline'] => ({
    id,
    rootPath: '/media',
    status: 'completed' as const,
    summary: { totalBytes, fileCount, directoryCount, errorCount: 0 },
    startedAt: '2026-10-28T15:00:00.000Z',
    finishedAt: '2026-10-28T15:00:03.000Z'
  })
  return {
    pair,
    compatibility,
    files,
    baseline: scan(pair.baselineScanId, before, baselineCount, beforeDirectories),
    target: scan(pair.targetScanId, after, targetCount, afterDirectories),
    observedSnapshotBytes: { baseline: before, target: after, delta: after - before },
    fileCountDelta: targetCount - baselineCount,
    directoryCountDelta: afterDirectories - beforeDirectories
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const metric = (name: string): ReturnType<typeof within> =>
  within(screen.getByRole('region', { name }))
const currency = (exact: string): string => exact + ' bytes'

test.each([
  [10000, 14000, '+4,000', '+4 KB', '+40%'],
  [14000, 10000, '−4,000', '−4 KB', '−28.6%'],
  [10000, 10000, '0', '0 B', '0%'],
  [0, 0, '0', '0 B', '0%'],
  [0, 3000, '+3,000', '+3 KB', null],
  [1000000, 1000001, '+1', '+1 B', '<0.1%']
] as const)(
  'shows observed size from %i to %i with signed delta and valid percentage',
  (before, after, exact, delta, change) => {
    render(<ComparisonSummaryView summary={fixture({ before, after })} />)
    const size = metric('Observed logical size')
    expect(size.getAllByTitle(currency(exact))[0]).toHaveTextContent(delta)
    if (change) expect(size.getByText(change)).toBeVisible()
    else expect(size.queryByText(/%/)).toBeNull()
    for (const value of [before, after])
      expect(
        size.getAllByTitle(currency(value.toLocaleString('en-US'))).length
      ).toBeGreaterThanOrEqual(1)
  }
)

test('uses the safe-integer range without truncating the exact tooltip or overflowing the percentage', () => {
  const max = Number.MAX_SAFE_INTEGER
  render(
    <ComparisonSummaryView
      summary={fixture({ before: 1, after: max, baselineCount: 0, targetCount: max })}
    />
  )
  const size = metric('Observed logical size')
  expect(size.getByTitle('+9,007,199,254,740,990 bytes')).toHaveTextContent('+9.01 PB')
  expect(size.getByTitle('9,007,199,254,740,991 bytes')).toBeVisible()
  expect(size.getByText('+900,719,925,474,099,000%')).toBeVisible()
  expect(metric('Observed file count').getByText('+9,007,199,254,740,991')).toBeVisible()
})

test('uses the supplied file and directory counts and deltas with root semantics intact', () => {
  render(<ComparisonSummaryView summary={fixture()} />)
  const files = metric('Observed file count')
  expect(files.getByText('+1')).toBeVisible()
  expect(files.getByText('8')).toBeVisible()
  expect(files.getByText('9')).toBeVisible()
  const folders = metric('Observed directory count')
  expect(folders.getByText('−2')).toBeVisible()
  expect(folders.getByText('5')).toBeVisible()
  expect(folders.getByText('3')).toBeVisible()
})

test('charts non-unchanged categories and shows distinct observed, known, and confirmed-only byte totals', () => {
  render(
    <ComparisonSummaryView
      summary={fixture({
        files: {
          counts: { added: 2, removed: 1, modified: 3, indeterminate: 4, unchanged: 89 },
          totalCount: 99,
          knownDeltaCount: 97,
          unknownDeltaCount: 2,
          positiveDeltaBytes: 6500,
          negativeDeltaBytes: -1500,
          netKnownDeltaBytes: 5000,
          confirmedKnownDeltaBytes: 2000,
          confirmedUnknownDeltaCount: 1
        }
      })}
    />
  )
  const donut = screen.getByRole('figure', { name: /Non-unchanged file records/ })
  expect(within(donut).getByText('10')).toBeVisible()
  expect(
    [...donut.querySelectorAll('[data-category]')].map((segment) =>
      segment.getAttribute('data-category')
    )
  ).toEqual(['added', 'removed', 'modified', 'indeterminate'])
  for (const [name, value] of [
    ['Added', 2],
    ['Removed', 1],
    ['Modified', 3],
    ['Indeterminate', 4],
    ['Unchanged', 89]
  ] as const) {
    const label = within(donut).getByText(name).closest('dt')!
    expect(label.nextElementSibling).toHaveTextContent(String(value))
  }
  expect(metric('Observed logical size').getByTitle('+4,000 bytes')).toBeVisible()
  const bytes = metric('File byte accounting')
  expect(bytes.getByTitle('+6,500 bytes')).toHaveTextContent('+6.5 KB')
  expect(bytes.getByTitle('−1,500 bytes')).toHaveTextContent('−1.5 KB')
  expect(bytes.getByText('Net known file delta').nextElementSibling).toHaveTextContent('+5 KB')
  expect(bytes.getByText('Confirmed-only known net').nextElementSibling).toHaveTextContent('+2 KB')
  expect(bytes.getByText('Unknown byte deltas').nextElementSibling).toHaveTextContent('2')
  expect(
    bytes.getByText('Confirmed changes with unknown bytes').nextElementSibling
  ).toHaveTextContent('1')
  const bars = screen
    .getByRole('figure', { name: /shared magnitude scale/ })
    .querySelectorAll<HTMLDivElement>('div[style]')
  expect(bars[0].style.width).toBe('100%')
  expect(parseFloat(bars[1].style.width)).toBeCloseTo((1500 / 6500) * 100)
  expect(screen.getByText(/Unknown byte deltas are excluded/)).toBeVisible()
})

test.each([
  ['empty', empty, 'No file records in either snapshot.'],
  [
    'unchanged',
    { ...empty, counts: { ...empty.counts, unchanged: 3 }, totalCount: 3, knownDeltaCount: 3 },
    'All file records are unchanged by available metadata.'
  ]
] as const)(
  'renders textual equivalents and known zero without empty geometry for %s files',
  (_, files, explanation) => {
    render(<ComparisonSummaryView summary={fixture({ before: 0, after: 0, files })} />)
    const donut = screen.getByRole('figure', { name: /Non-unchanged file records/ })
    expect(within(donut).getByText(explanation)).toBeVisible()
    expect(donut.querySelector('svg')).toBeNull()
    const bytes = metric('File byte accounting')
    expect(bytes.getAllByTitle('0 bytes')).toHaveLength(4)
    expect(bytes.queryByText('Unavailable')).toBeNull()
  }
)

test('charts an indeterminate-only distribution and preserves a known numeric delta', () => {
  const files = {
    ...empty,
    counts: { ...empty.counts, indeterminate: 2 },
    totalCount: 2,
    knownDeltaCount: 2,
    positiveDeltaBytes: 99,
    netKnownDeltaBytes: 99
  }
  render(<ComparisonSummaryView summary={fixture({ files })} />)
  const donut = screen.getByRole('figure', { name: /Non-unchanged file records/ })
  expect(donut.querySelectorAll('[data-category]')).toHaveLength(1)
  expect(donut.querySelector('[data-category="indeterminate"]')).toBeInTheDocument()
  const accounting = metric('File byte accounting')
  expect(accounting.getByText('Net known file delta').nextElementSibling).toHaveTextContent('+99 B')
  expect(accounting.getByText('Confirmed-only known net').nextElementSibling).toHaveTextContent(
    '0 B'
  )
  expect(accounting.getByText('Unknown byte deltas').nextElementSibling).toHaveTextContent('0')
})

test('shows unavailable totals and no bar geometry when all deltas including confirmed changes are unknown', () => {
  const files = {
    ...empty,
    counts: { ...empty.counts, indeterminate: 1, removed: 1 },
    totalCount: 2,
    unknownDeltaCount: 2,
    confirmedUnknownDeltaCount: 1
  }
  render(<ComparisonSummaryView summary={fixture({ files })} />)
  expect(metric('File byte accounting').getAllByText('Unavailable')).toHaveLength(4)
  expect(
    screen.getByRole('figure', { name: /shared magnitude scale/ }).querySelector('div[style]')
  ).toBeNull()
  expect(screen.getByText(/Some file changes could not be confirmed/)).toBeVisible()
})

test.each([
  ['complete', 'complete'],
  ['incomplete', 'complete'],
  ['complete', 'incomplete'],
  ['incomplete', 'incomplete'],
  ['unknown', 'complete']
] as const)(
  'shows authoritative %s Baseline and %s Target coverage while retaining known metrics',
  async (baseline, target) => {
    const withCoverage = { ...compatible, coverage: { baseline, target } }
    const read = vi
      .fn<SpaceLensAPI['getComparisonSummary']>()
      .mockResolvedValue({ ok: true, value: fixture({ compatibility: withCoverage }) })
    vi.stubGlobal('spaceLens', { getComparisonSummary: read })
    render(
      <StrictMode>
        <ComparisonDashboard
          selection={{ selectionId: 'adopted', compatibility: compatible }}
          scanActive={false}
        />
      </StrictMode>
    )
    expect(await screen.findByRole('region', { name: 'Observed logical size' })).toBeVisible()
    expect(read).toHaveBeenCalledExactlyOnceWith({ selectionId: 'adopted', query: pair })
    if (baseline === 'complete' && target === 'complete') {
      expect(screen.getByText('Both snapshots have complete coverage.')).toBeVisible()
      expect(screen.queryByText(/Observed differences may reflect gaps/)).toBeNull()
    } else {
      if (baseline === 'incomplete')
        expect(screen.getByText(/Baseline has partial coverage/)).toBeVisible()
      if (target === 'incomplete')
        expect(screen.getByText(/Target has partial coverage/)).toBeVisible()
      if (baseline === 'unknown')
        expect(screen.getByText(/Coverage for the Baseline is unknown/)).toBeVisible()
      expect(screen.getByText(/Incomplete coverage can omit entries/)).toBeVisible()
    }
  }
)

test('rejects a Summary returned for a different pair', async () => {
  const summary = { ...fixture(), pair: { baselineScanId: 'target', targetScanId: 'baseline' } }
  vi.stubGlobal('spaceLens', {
    getComparisonSummary: vi
      .fn<SpaceLensAPI['getComparisonSummary']>()
      .mockResolvedValue({ ok: true, value: summary })
  })
  render(
    <ComparisonDashboard
      selection={{ selectionId: 'adopted', compatibility: compatible }}
      scanActive={false}
    />
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The comparison summary could not be loaded.'
  )
  expect(screen.queryByRole('region', { name: /Observed logical size/ })).toBeNull()
})
