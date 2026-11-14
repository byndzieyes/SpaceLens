import { render, screen, within, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'
import App from '../src/renderer/src/App'
import { ExplorerPage } from '../src/renderer/src/pages/ExplorerPage'

const api: SpaceLensAPI = {
  getAppInfo: vi.fn(),
  getScanState: vi.fn(),
  getScanSnapshot: vi.fn(),
  getScanEntry: vi.fn(),
  listScanDirectory: vi.fn(),
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

test('shows honest empty states without scan requests, paths, or file rows', () => {
  const { container } = render(<ExplorerPage />)
  for (const text of [
    'No directory displayed',
    'No directories displayed',
    'Scan data is not displayed in Explorer yet.',
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

test('reserves navigation and pagination with disabled, named controls', () => {
  render(<ExplorerPage />)
  const navigation = within(screen.getByRole('group', { name: 'Directory navigation' }))
  for (const name of ['Back', 'Forward', 'Up']) {
    expect(navigation.getByRole('button', { name })).toBeDisabled()
  }
  expect(screen.getByText('Loading snapshot?')).toBeVisible()
  const pagination = within(screen.getByRole('group', { name: 'Directory contents pagination' }))
  for (const name of ['Previous page', 'Next page']) {
    expect(pagination.getByRole('button', { name })).toBeDisabled()
  }
  expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(
    true
  )
})

test('provides an accessible table with contract-backed columns and a readable empty description', () => {
  render(<ExplorerPage />)
  const table = screen.getByRole('table', {
    name: 'Files and directories in the displayed directory'
  })
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
  ).toEqual(['Name', 'Type', 'Size', 'Modified'])
  for (const header of within(table).getAllByRole('columnheader')) {
    expect(header).toHaveAttribute('scope', 'col')
  }
  expect(within(table).getAllByRole('row')).toHaveLength(1)
  expect(within(table).queryByRole('cell')).not.toBeInTheDocument()
  expect(table).toHaveAccessibleDescription('No directory contents to display')
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
