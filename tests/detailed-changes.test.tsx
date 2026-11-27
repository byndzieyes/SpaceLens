import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  AdoptedComparisonSelection,
  ComparisonDirectoryChange,
  ComparisonFileChange,
  ComparisonFileQuery,
  ComparisonPathObservation,
  ComparisonSide,
  EntryChangeKind
} from '../src/shared/comparison'
import type { SpaceLensAPI } from '../src/shared/ipc'
import { DetailedChanges } from '../src/renderer/src/features/comparison/DetailedChanges'

const pair = { baselineScanId: 'before', targetScanId: 'after' }
const selection: AdoptedComparisonSelection = {
  selectionId: 'adopted-1',
  compatibility: {
    pair,
    status: 'compatible',
    normalizedRoot: '/scans',
    pathStyle: 'posix',
    coverage: { baseline: 'complete', target: 'complete' }
  }
}
const files = vi.fn<SpaceLensAPI['listComparisonFileChanges']>()
const directories = vi.fn<SpaceLensAPI['listComparisonDirectoryChanges']>()
const open = vi.fn()
const longPath = 'folder/' + 'part-with-a-long-name/'.repeat(12) + 'zero.txt'

function observed(
  side: ComparisonSide,
  entryId: string,
  sizeBytes: number | null,
  type: 'file' | 'directory' = 'file'
): ComparisonPathObservation {
  return {
    presence: 'present',
    entry: {
      scanId: side === 'baseline' ? 'before' : 'after',
      entryId,
      type,
      sizeBytes,
      modifiedAt: null
    }
  }
}

const allKinds: ComparisonFileChange[] = [
  {
    relativePath: longPath,
    kind: 'added',
    reason: 'confirmed-absence',
    baseline: { presence: 'absent' },
    target: observed('target', 'zero', 0),
    deltaBytes: 0
  },
  {
    relativePath: 'folder/gone',
    kind: 'removed',
    reason: 'confirmed-absence',
    baseline: observed('baseline', 'gone', 1000),
    target: { presence: 'absent' },
    deltaBytes: -1000
  },
  {
    relativePath: 'folder/changed',
    kind: 'modified',
    reason: 'size-changed',
    baseline: observed('baseline', 'changed-1', 500),
    target: observed('target', 'changed-2', 750),
    deltaBytes: 250
  },
  {
    relativePath: 'folder/steady',
    kind: 'unchanged',
    reason: 'metadata-equal',
    baseline: observed('baseline', 'steady-1', 10),
    target: observed('target', 'steady-2', 10),
    deltaBytes: 0
  },
  {
    relativePath: 'folder/maybe',
    kind: 'indeterminate',
    reason: 'unknown-presence',
    baseline: { presence: 'unknown' },
    target: observed('target', 'maybe', null),
    deltaBytes: null
  },
  {
    relativePath: '00-replace',
    kind: 'removed',
    reason: 'type-replacement',
    baseline: observed('baseline', 'replace-file', 200),
    target: observed('target', 'replace-dir', null, 'directory'),
    deltaBytes: -200
  }
]
const extra = Array.from({ length: 25 }, (_, index): ComparisonFileChange => ({
  relativePath: 'other/item-' + String(index).padStart(2, '0'),
  kind: 'added',
  reason: 'confirmed-absence',
  baseline: { presence: 'absent' },
  target: observed('target', 'additional-' + index, index + 10),
  deltaBytes: index + 10
}))
const zeroFiles = {
  counts: { added: 0, removed: 0, modified: 0, unchanged: 0, indeterminate: 0 },
  knownDeltaCount: 0,
  unknownDeltaCount: 0,
  totalCount: 0,
  positiveDeltaBytes: 0,
  negativeDeltaBytes: 0,
  netKnownDeltaBytes: 0,
  confirmedKnownDeltaBytes: 0,
  confirmedUnknownDeltaCount: 0
}
function directory(
  relativePath: string,
  kind: EntryChangeKind,
  before: number | null,
  after: number | null
): ComparisonDirectoryChange {
  const reference = (
    scanId: string,
    observedBytes: number | null
  ): ComparisonDirectoryChange['baseline'] => ({
    presence: 'present',
    entry: {
      scanId,
      entryId: 'dir-' + scanId + '-' + relativePath.replaceAll('/', '-'),
      type: 'directory'
    },
    observedBytes
  })
  return {
    relativePath,
    kind,
    baseline: kind === 'added' ? { presence: 'absent' } : reference('before', before),
    target: kind === 'removed' ? { presence: 'absent' } : reference('after', after),
    observedDeltaBytes: before === null || after === null ? null : after - before,
    uncertain: before === null || after === null,
    subtreeFiles:
      relativePath === 'folder'
        ? { ...zeroFiles, counts: { ...zeroFiles.counts, modified: 7 } }
        : zeroFiles,
    typeReplacement: relativePath === 'replacement'
  }
}

const directoryRows = [
  directory('', 'modified', 4000, 4200),
  directory('created', 'added', 0, 0),
  directory('deleted', 'removed', 0, 0),
  directory('folder', 'modified', 1000, 2000),
  directory('folder/child', 'modified', 500, 1000),
  directory('reduced', 'modified', 2500, 500),
  directory('replacement', 'added', 0, 0),
  directory('uncertain', 'indeterminate', null, 30)
]

function fixturePage<Row extends { relativePath: string; kind: EntryChangeKind }>(
  rows: readonly Row[],
  query: ComparisonFileQuery,
  delta: (row: Row) => number | null
): {
  pair: typeof pair
  compatibility: AdoptedComparisonSelection['compatibility']
  items: Row[]
  offset: number
  limit: number
  totalCount: number
  nextOffset: number | null
} {
  const {
    relativeDirectory,
    kinds,
    limit = 20,
    offset = 0,
    sort = 'path',
    baselineScanId,
    targetScanId
  } = query
  const requestedPair = { baselineScanId, targetScanId }
  const matches = rows.filter(
    (row) =>
      (!kinds || kinds.includes(row.kind)) &&
      (!relativeDirectory ||
        row.relativePath === relativeDirectory ||
        row.relativePath.startsWith(relativeDirectory + '/'))
  )
  matches.sort((a, b) => {
    const av = delta(a)
    const bv = delta(b)
    if (sort !== 'path' && av !== bv) {
      if (av === null) return 1
      if (bv === null) return -1
      return sort === 'delta-desc' ? bv - av : av - bv
    }
    return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  })
  return {
    pair: requestedPair,
    compatibility: { ...selection.compatibility, pair: requestedPair },
    items: matches.slice(offset, offset + limit),
    offset,
    limit,
    totalCount: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  files.mockImplementation(async ({ query }) => ({
    ok: true,
    value: fixturePage([...allKinds, ...extra], query, (row) => row.deltaBytes)
  }))
  directories.mockImplementation(async ({ query }) => ({
    ok: true,
    value: fixturePage(
      query.includeRoot ? directoryRows : directoryRows.slice(1),
      query,
      (row) => row.observedDeltaBytes
    )
  }))
  vi.stubGlobal('spaceLens', {
    listComparisonFileChanges: files,
    listComparisonDirectoryChanges: directories
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const tab = (name: 'File Changes' | 'Directory Changes'): HTMLElement =>
  screen.getByRole('tab', { name })
const click = (element: HTMLElement): void => {
  fireEvent.click(element)
}
const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const table = (name: 'File changes' | 'Directory changes'): HTMLElement =>
  screen.getByRole('table', { name })
const show = (scanActive = false): ReturnType<typeof render> =>
  render(<DetailedChanges selection={selection} scanActive={scanActive} onOpen={open} />)
function filter(label: string, value: string): void {
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } })
}
function actions(path: string): HTMLElement {
  const trigger = button('Actions for ' + path)
  click(trigger)
  return screen.getByRole('menu', { name: 'Change actions' })
}

test('loads only the requested tab, keeps exact identity and pagination when switching, and scopes queries on the server', async () => {
  show()
  expect(files).not.toHaveBeenCalled()
  expect(directories).not.toHaveBeenCalled()
  const first = tab('File Changes')
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowRight' })
  expect(tab('Directory Changes')).toHaveFocus()
  expect(files).not.toHaveBeenCalled()
  click(first)
  await screen.findByText(/Showing 1–20 of 31 records/)
  expect(files).toHaveBeenCalledExactlyOnceWith({
    selectionId: selection.selectionId,
    query: { ...pair, offset: 0, limit: 20, sort: 'path' }
  })
  click(button('Next changes page'))
  await screen.findByText(/Showing 21–31 of 31 records/)
  expect(files).toHaveBeenLastCalledWith({
    selectionId: selection.selectionId,
    query: { ...pair, offset: 20, limit: 20, sort: 'path' }
  })
  click(tab('Directory Changes'))
  await screen.findByRole('table', { name: 'Directory changes' })
  expect(screen.queryByRole('table', { name: 'File changes' })).toBeNull()
  expect(directories).toHaveBeenCalledTimes(1)
  click(first)
  expect(screen.getByText(/Showing 21–31 of 31 records/)).toBeVisible()
  expect(files).toHaveBeenCalledTimes(2)
  filter('File classification', 'indeterminate')
  filter('Sort', 'delta-asc')
  await screen.findByText(/Showing 1–1 of 1 records/)
  expect(files).toHaveBeenLastCalledWith({
    selectionId: selection.selectionId,
    query: { ...pair, offset: 0, limit: 20, sort: 'delta-asc', kinds: ['indeterminate'] }
  })
})

test('displays classifications, exact paths, sizes, and only file references for the correct side', async () => {
  show()
  click(tab('File Changes'))
  await screen.findByRole('table', { name: 'File changes' })
  const row = (path: string): ReturnType<typeof within> =>
    within(
      table('File changes').querySelector(`[title="${path}"]`)?.closest('tr') ??
        within(table('File changes')).getByText(path, { selector: 'th span' }).closest('tr')!
    )
  const zero = row(longPath)
  expect(zero.getByText('Added')).toBeVisible()
  expect(zero.getByText('Absent')).toBeVisible()
  expect(zero.getAllByTitle('0 bytes')).toHaveLength(2)
  expect(zero.getByTitle(longPath)).toBeVisible()
  expect(row('folder/gone').getByTitle('−1,000 bytes')).toBeVisible()
  expect(row('folder/changed').getByText('Size changed')).toBeVisible()
  expect(row('folder/steady').getByText('Available size and timestamp match')).toBeVisible()
  expect(row('folder/maybe').getAllByText('Unknown')).toHaveLength(3)
  expect(row('00-replace').getByText('Type replacement')).toBeVisible()
  expect(row('00-replace').getByText('Not a file')).toBeVisible()
  const menu = actions('00-replace')
  expect(within(menu).queryByRole('menuitem', { name: 'Open Target in Explorer' })).toBeNull()
  click(within(menu).getByRole('menuitem', { name: 'Open Baseline in Explorer' }))
  expect(open).toHaveBeenCalledWith(
    'baseline',
    expect.objectContaining({ scanId: 'before', entryId: 'replace-file', type: 'file' })
  )
  const modified = actions('folder/changed')
  const target = within(modified).getByRole('menuitem', { name: 'Open Target in Explorer' })
  fireEvent.keyDown(target, { key: 'Escape' })
  expect(button('Actions for folder/changed')).toHaveFocus()
  expect(screen.queryByRole('menu')).toBeNull()
  click(within(actions('folder/maybe')).getByRole('menuitem', { name: 'Open Target in Explorer' }))
  expect(open).toHaveBeenLastCalledWith(
    'target',
    expect.objectContaining({ scanId: 'after', entryId: 'maybe' })
  )
})

test('uses signed ordering, server scope, and distinguishes empty filtered results', async () => {
  show()
  click(tab('Directory Changes'))
  await screen.findByRole('table', { name: 'Directory changes' })
  const menu = actions('folder')
  click(within(menu).getByRole('menuitem', { name: 'View file changes' }))
  await screen.findByText(/Showing 1–5 of 5 records/)
  expect(files).toHaveBeenLastCalledWith({
    selectionId: selection.selectionId,
    query: { ...pair, limit: 20, offset: 0, sort: 'path', relativeDirectory: 'folder' }
  })
  for (const sort of ['delta-desc', 'delta-asc']) {
    filter('Sort', sort)
    await waitFor(() => expect(files.mock.lastCall?.[0].query.sort).toBe(sort))
    await waitFor(() =>
      expect(table('File changes').querySelector('tbody tr:last-child')).toHaveTextContent(
        'folder/maybe'
      )
    )
  }
  click(button('Return to root'))
  await screen.findByText(/Showing 1–20 of 31 records/)
  click(tab('Directory Changes'))
  await screen.findByRole('table', { name: 'Directory changes' })
  click(within(actions('created')).getByRole('menuitem', { name: 'View file changes' }))
  expect(await screen.findByText('No matching changes.')).toBeVisible()
  expect(screen.getByText('0 records')).toBeVisible()
})

test('shows zero-byte structural changes, uncertainty, root opt-in, and subtree counts', async () => {
  show()
  click(tab('Directory Changes'))
  await screen.findByRole('table', { name: 'Directory changes' })
  const row = (path: string): ReturnType<typeof within> =>
    within(within(table('Directory changes')).getByRole('rowheader', { name: path }).closest('tr')!)
  expect(row('created').getByText('Added')).toBeVisible()
  expect(row('created').getAllByTitle('0 bytes')).toHaveLength(2)
  expect(row('deleted').getByText('Removed')).toBeVisible()
  expect(row('deleted').getAllByTitle('0 bytes')).toHaveLength(2)
  expect(row('uncertain').getByText('Uncertain coverage or changes')).toBeVisible()
  expect(row('folder').getByText('Modified 7')).toBeVisible()
  expect(row('replacement').getByText('Type replacement')).toBeVisible()
  expect(
    within(table('Directory changes')).queryByRole('rowheader', { name: 'Comparison root' })
  ).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include comparison root' }))
  expect(
    await within(await screen.findByRole('table', { name: 'Directory changes' })).findByRole(
      'rowheader',
      { name: 'Comparison root' }
    )
  ).toBeVisible()
  expect(directories.mock.lastCall?.[0].query.includeRoot).toBe(true)
  click(within(actions('folder')).getByRole('menuitem', { name: 'Inspect subtree' }))
  await screen.findByText(/Showing 1–2 of 2 records/)
  expect(directories.mock.lastCall?.[0].query).toMatchObject({
    relativeDirectory: 'folder',
    offset: 0
  })
  expect(directories.mock.lastCall?.[0].query.includeRoot).toBeUndefined()
  filter('Directory status', 'modified')
  filter('Sort', 'delta-asc')
  await screen.findByRole('table', { name: 'Directory changes' })
  await waitFor(() =>
    expect(directories.mock.lastCall?.[0].query).toMatchObject({
      relativeDirectory: 'folder',
      kinds: ['modified'],
      sort: 'delta-asc'
    })
  )
})

test('loads bounded sign-only rankings sequentially and reuses the matching directory page', async () => {
  show()
  click(tab('Directory Changes'))
  await screen.findByRole('table', { name: 'Directory changes' })
  filter('Sort', 'delta-desc')
  await waitFor(() => expect(directories.mock.lastCall?.[0].query.sort).toBe('delta-desc'))
  await screen.findByRole('table', { name: 'Directory changes' })
  const growth = screen.getByRole('region', { name: 'Largest growing directories' })
  const reduction = screen.getByRole('region', { name: 'Largest shrinking directories' })
  click(button('Load growth ranking'))
  expect(await within(growth).findByText('folder/child')).toBeVisible()
  expect(within(growth).getByTitle('+1,000 bytes')).toBeVisible()
  expect(within(growth).queryByText('reduced')).toBeNull()
  expect(directories).toHaveBeenCalledTimes(2)
  click(button('Load reduction ranking'))
  expect(await within(reduction).findByText('reduced')).toBeVisible()
  expect(within(reduction).getByTitle('−2,000 bytes')).toBeVisible()
  expect(within(reduction).queryByText('deleted')).toBeNull()
  expect(directories.mock.lastCall?.[0].query).toEqual({
    ...pair,
    sort: 'delta-asc',
    offset: 0,
    limit: 5
  })
  expect(screen.getByText(/parent and child results may overlap/)).toBeVisible()
})

test('keeps empty directory references side-specific and reports scope with no qualifying ranking', async () => {
  show()
  click(tab('Directory Changes'))
  await screen.findByRole('table', { name: 'Directory changes' })
  const removed = actions('deleted')
  expect(within(removed).queryByRole('menuitem', { name: 'Open Target in Explorer' })).toBeNull()
  click(within(removed).getByRole('menuitem', { name: 'Open Baseline in Explorer' }))
  expect(open).toHaveBeenCalledWith('baseline', {
    scanId: 'before',
    entryId: 'dir-before-deleted',
    type: 'directory'
  })
  const added = actions('created')
  expect(within(added).queryByRole('menuitem', { name: 'Open Baseline in Explorer' })).toBeNull()
  click(within(added).getByRole('menuitem', { name: 'Open Target in Explorer' }))
  expect(open).toHaveBeenLastCalledWith('target', {
    scanId: 'after',
    entryId: 'dir-after-created',
    type: 'directory'
  })
  click(within(actions('created')).getByRole('menuitem', { name: 'Inspect subtree' }))
  await screen.findByRole('table', { name: 'Directory changes' })
  click(button('Load growth ranking'))
  expect(await screen.findByText('No directories with known growth in this scope.')).toBeVisible()
  expect(directories.mock.lastCall?.[0].query).toMatchObject({
    relativeDirectory: 'created',
    sort: 'delta-desc',
    limit: 5
  })
})

test('serializes rank requests with the table and ignores intermediate filters while showing only the selected tab', async () => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listComparisonFileChanges']>>>()
  files.mockReturnValueOnce(pending.promise)
  show()
  click(tab('File Changes'))
  await waitFor(() => expect(files).toHaveBeenCalledOnce())
  filter('File classification', 'modified')
  filter('File classification', 'removed')
  click(tab('Directory Changes'))
  click(button('Load growth ranking'))
  click(button('Load reduction ranking'))
  expect(directories).not.toHaveBeenCalled()
  await act(async () =>
    pending.resolve({
      ok: true,
      value: fixturePage(allKinds, { ...pair, offset: 0, limit: 20 }, (row) => row.deltaBytes)
    })
  )
  await waitFor(() => expect(directories).toHaveBeenCalledTimes(3))
  expect(directories.mock.calls.map(([r]) => r.query.sort)).toEqual([
    'path',
    'delta-desc',
    'delta-asc'
  ])
  expect(screen.queryByRole('table', { name: 'File changes' })).toBeNull()
  click(tab('File Changes'))
  await screen.findByText(/Showing 1–2 of 2 records/)
  expect(files).toHaveBeenCalledTimes(2)
  expect(files.mock.lastCall?.[0].query.kinds).toEqual(['removed'])
})

test('deduplicates a dispatched query across quick tab switches and preserves its cached results during a scan', async () => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<SpaceLensAPI['listComparisonFileChanges']>>>()
  files.mockReturnValueOnce(pending.promise)
  const ui = show()
  click(tab('File Changes'))
  await waitFor(() => expect(files).toHaveBeenCalledOnce())
  click(tab('Directory Changes'))
  click(tab('File Changes'))
  await act(async () =>
    pending.resolve({
      ok: true,
      value: fixturePage(allKinds, { ...pair, offset: 0, limit: 20 }, (row) => row.deltaBytes)
    })
  )
  await screen.findByRole('table', { name: 'File changes' })
  expect(files).toHaveBeenCalledOnce()
  ui.rerender(<DetailedChanges selection={selection} scanActive onOpen={open} />)
  expect(table('File changes')).toBeVisible()
  expect(button('Refresh results')).toBeDisabled()
  expect(files).toHaveBeenCalledOnce()
})

test.each(['scanner', 'COMPARISON_SCAN_ACTIVE', 'COMPARISON_TIMEOUT', 'UNAVAILABLE'] as const)(
  'requires explicit retry after %s',
  async (mode) => {
    if (mode !== 'scanner')
      files.mockResolvedValueOnce({
        ok: false,
        error: { code: mode, message: 'private diagnostic' }
      })
    const view = show(mode === 'scanner')
    click(tab('File Changes'))
    const alert = await screen.findByRole('alert')
    expect(alert).not.toHaveTextContent('private diagnostic')
    expect(alert).toHaveTextContent(
      mode === 'scanner'
        ? /while a scan is active/
        : mode === 'COMPARISON_SCAN_ACTIVE'
          ? /A scan paused/
          : mode === 'COMPARISON_TIMEOUT'
            ? /timed out/
            : /storage is unavailable/
    )
    const calls = mode === 'scanner' ? 0 : 1
    if (mode === 'scanner') expect(button('Retry')).toBeDisabled()
    view.rerender(<DetailedChanges selection={selection} scanActive={false} onOpen={open} />)
    expect(files).toHaveBeenCalledTimes(calls)
    click(button('Retry'))
    await screen.findByRole('table', { name: 'File changes' })
    expect(files).toHaveBeenCalledTimes(calls + 1)
  }
)
