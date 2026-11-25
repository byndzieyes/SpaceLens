import { render, screen, within, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import App from '../src/renderer/src/App'
import { ExplorerPage } from '../src/renderer/src/pages/ExplorerPage'

const api: SpaceLensAPI = {
  getAppInfo: vi.fn(),
  getScanState: vi.fn(),
  listScanHistory: vi.fn(),
  getScanHistoryMetadata: vi.fn(),
  deleteSnapshot: vi.fn(),
  getScanSnapshot: vi.fn(),
  getScanEntry: vi.fn(),
  listScanDirectory: vi.fn(),
  getScanDirectoryTreemap: vi.fn(),
  getInsightsSummary: vi.fn(),
  getInsightsCategories: vi.fn(),
  getInsightsSizeDistribution: vi.fn(),
  getInsightsObservations: vi.fn(),
  listInsightsExtensions: vi.fn(),
  listInsightsLargestFiles: vi.fn(),
  listInsightsLargestDirectories: vi.fn(),
  onScanStateChanged: vi.fn(() => () => {}),
  selectScanDirectory: vi.fn(),
  startScan: vi.fn(),
  cancelScan: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getScanState).mockResolvedValue({ ok: true, value: { revision: 0, state: null } })
  vi.mocked(api.getScanSnapshot).mockResolvedValue({
    ok: true,
    value: { snapshot: null, unavailable: null }
  })
  vi.stubGlobal('spaceLens', api)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

test('renders the Explorer heading and four named workspace panels', () => {
  render(<ExplorerPage />)
  expect(screen.getByRole('heading', { level: 2, name: 'Storage Explorer' })).toBeVisible()
  for (const name of ['Directory Tree', 'Treemap', 'Details', 'Directory Contents']) {
    const panel = screen.getByRole('region', { name })
    expect(within(panel).getByRole('heading', { level: 3, name })).toBeVisible()
  }
})

test('shows resolved empty states without scan requests, paths, or file rows', async () => {
  const { container } = render(<ExplorerPage />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading snapshot…')
  expect(screen.queryByText('No directories displayed')).not.toBeInTheDocument()
  await screen.findByText(/No published snapshot yet/)
  for (const text of [
    'No directory displayed',
    'No directories displayed',
    'No treemap available. An available snapshot and current directory are required.',
    'No item selected',
    'No directory contents to display'
  ])
    expect(screen.getByText(text)).toBeVisible()
  expect(container.textContent).not.toMatch(/[A-Z]:\\|\/home\/|\/Users\//)
  expect(screen.queryByRole('treeitem')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(api.listScanDirectory).not.toHaveBeenCalled()
})

test('a failed availability check stays distinct from an empty result and can be refreshed', async () => {
  vi.mocked(api.getScanSnapshot).mockRejectedValueOnce(new Error('Disconnected'))
  render(<ExplorerPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent(/Use Refresh snapshot/)
  expect(screen.queryByText(/No published snapshot yet/)).not.toBeInTheDocument()
  expect(screen.queryByText('No directories displayed')).not.toBeInTheDocument()
  expect(api.listScanDirectory).not.toHaveBeenCalled()
  expect(api.getScanDirectoryTreemap).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }))
  await screen.findByText(/No published snapshot yet/)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(api.getScanSnapshot).toHaveBeenCalledTimes(2)
})

test('keeps navigation disabled until availability resolves and disables empty pagination', async () => {
  render(<ExplorerPage />)
  const navigation = within(screen.getByRole('group', { name: 'Directory navigation' }))
  for (const name of ['Back', 'Forward', 'Up', 'Refresh snapshot']) {
    const control = navigation.getByRole('button', { name })
    expect(control).toHaveAttribute('aria-disabled', 'true')
    expect(control).toHaveAttribute('tabindex', '-1')
  }
  expect(screen.getByText('Loading snapshot…')).toBeVisible()
  const pagination = within(
    await screen.findByRole('group', { name: 'Directory contents pagination' })
  )
  for (const name of ['Previous page', 'Next page']) {
    expect(pagination.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true')
  }
  expect(navigation.getByRole('button', { name: 'Refresh snapshot' })).toHaveAttribute(
    'aria-disabled',
    'false'
  )
})

test('provides an accessible table with contract-backed columns and a readable empty description', async () => {
  render(<ExplorerPage />)
  const table = await screen.findByRole('table', {
    name: 'Files and directories in the displayed directory'
  })
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
  ).toEqual(['Name', 'Type', 'Size'])
  for (const header of within(table).getAllByRole('columnheader')) {
    expect(header).toHaveAttribute('scope', 'col')
  }
  expect(within(table).getAllByRole('row')).toHaveLength(1)
  expect(within(table).queryByRole('cell')).not.toBeInTheDocument()
  expect(table).toHaveAccessibleDescription(/Press Space to select an entry/)
  expect(screen.getByRole('region', { name: 'Directory contents table' })).toHaveAttribute(
    'tabindex',
    '0'
  )
})

test('starts on Overview and switches to Explorer and back using existing navigation', async () => {
  render(<App />)
  await screen.findByText('Ready to scan')
  const navigation = within(screen.getByRole('navigation', { name: 'Main navigation' }))
  expect(navigation.getByRole('button', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  expect(screen.getByRole('heading', { name: 'Storage Overview' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Storage Explorer' })).not.toBeInTheDocument()

  fireEvent.click(navigation.getByRole('button', { name: 'Explorer' }))
  expect(screen.getByRole('heading', { name: 'Storage Explorer' })).toBeVisible()
  expect(navigation.getByRole('button', { name: 'Explorer' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  expect(screen.queryByRole('heading', { name: 'Storage Overview' })).not.toBeInTheDocument()
  await screen.findByText(/No published snapshot yet/)
  expect(api.getScanState).toHaveBeenCalledTimes(1)
  expect(api.getScanSnapshot).toHaveBeenCalledOnce()
  expect(api.getScanEntry).not.toHaveBeenCalled()
  expect(api.listScanDirectory).not.toHaveBeenCalled()

  fireEvent.click(navigation.getByRole('button', { name: 'Overview' }))
  await screen.findByText('Ready to scan')
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
  expect(screen.getByRole('heading', { name: 'Storage Devices' })).toBeVisible()
  expect(api.startScan).not.toHaveBeenCalled()
  expect(api.cancelScan).not.toHaveBeenCalled()
})
