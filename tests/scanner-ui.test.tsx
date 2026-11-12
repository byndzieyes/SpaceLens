import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ScannerIpcResult, ScanStateSnapshot, SpaceLensAPI } from '../src/shared/ipc'
import type { ScanSessionState, ScanStatus } from '../src/shared/scan'
import { OverviewPage } from '../src/renderer/src/pages/OverviewPage'
import App from '../src/renderer/src/App'

let api: SpaceLensAPI
let latest: ScanStateSnapshot
let listeners: Set<(snapshot: ScanStateSnapshot) => void>
const rootPath = 'C:\\Test folders\\Україна & notes'

function snapshot(
  revision: number,
  status: ScanStatus = 'running',
  id = 'scan-a',
  errors = 0
): ScanStateSnapshot {
  const scan: ScanSessionState = {
    session: {
      id,
      rootPath,
      status,
      startedAt: '2026-11-11T10:00:00Z',
      finishedAt: status === 'running' ? null : '2026-11-11T10:01:00Z',
      summary: { fileCount: 1234, directoryCount: 12, totalBytes: 300_000_000, errorCount: errors }
    } as ScanSessionState['session'],
    progress: {
      scanId: id,
      processedFileCount: 1000,
      processedDirectoryCount: 10,
      processedBytes: 200_000_000,
      currentPath: rootPath + '\\nested\\file.txt'
    },
    failure:
      status === 'failed'
        ? { name: 'Error', code: 'SCAN_FAILED', message: 'The scan could not be completed.' }
        : null
  }
  return { revision, state: scan }
}
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function emit(value: ScanStateSnapshot): void {
  latest = value
  act(() => {
    for (const listener of listeners) listener(value)
  })
}
async function mount(): Promise<void> {
  render(<OverviewPage />)
  await screen.findByText('Ready to scan')
}
function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Folder scan' })
}

beforeEach(() => {
  latest = { revision: 0, state: null }
  listeners = new Set()
  api = {
    getAppInfo: vi.fn(),
    getScanState: vi.fn<SpaceLensAPI['getScanState']>(async () => ({ ok: true, value: latest })),
    getScanSnapshot: vi.fn(),
    getScanEntry: vi.fn(),
    listScanDirectory: vi.fn(),
    onScanStateChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    selectScanDirectory: vi.fn<SpaceLensAPI['selectScanDirectory']>(async () => ({
      ok: true,
      value: { cancelled: false, rootPath }
    })),
    startScan: vi.fn<SpaceLensAPI['startScan']>(async () => {
      emit(snapshot(1))
      return { ok: true, value: { scanId: 'scan-a' } }
    }),
    cancelScan: vi.fn<SpaceLensAPI['cancelScan']>(async () => ({
      ok: true,
      value: { scanId: 'scan-a' }
    }))
  }
  vi.stubGlobal('spaceLens', api)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('loads current state without starting a scan and exposes an accessible action', async () => {
  await mount()
  expect(api.getScanState).toHaveBeenCalledOnce()
  expect(api.selectScanDirectory).not.toHaveBeenCalled()
  expect(api.startScan).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
  expect(within(panel()).queryByRole('button', { name: 'Cancel Scan' })).not.toBeInTheDocument()
  expect(within(panel()).getByRole('status')).toHaveTextContent('Ready to scan')
})

test('selects once and starts once with the exact returned path despite repeated clicks', async () => {
  const selection = deferred<Awaited<ReturnType<SpaceLensAPI['selectScanDirectory']>>>()
  vi.mocked(api.selectScanDirectory).mockReturnValue(selection.promise)
  await mount()
  const button = screen.getByRole('button', { name: 'Scan Folder' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(api.selectScanDirectory).toHaveBeenCalledOnce()
  expect(button).toBeDisabled()
  await act(async () => {
    selection.resolve({ ok: true, value: { cancelled: false, rootPath } })
  })
  await screen.findByText('Scanning')
  expect(api.startScan).toHaveBeenCalledExactlyOnceWith({ rootPath })
  fireEvent.click(button)
  expect(api.startScan).toHaveBeenCalledOnce()
})

test('cancelled selection preserves the previous completed result and starts nothing', async () => {
  latest = snapshot(1, 'completed')
  vi.mocked(api.selectScanDirectory).mockResolvedValue({ ok: true, value: { cancelled: true } })
  render(<OverviewPage />)
  await screen.findByText('Scan completed')
  fireEvent.click(screen.getByRole('button', { name: 'Scan Folder' }))
  await screen.findByText('Folder selection cancelled. No new scan was started.')
  expect(screen.getByText('Scan completed')).toBeVisible()
  expect(within(panel()).getByText('300 MB')).toBeVisible()
  expect(api.startScan).not.toHaveBeenCalled()
})

test.each(['PATH_NOT_AUTHORIZED', 'DIRECTORY_UNAVAILABLE'] as const)(
  'explains %s and requires another selection',
  async (code) => {
    vi.mocked(api.startScan).mockResolvedValue({
      ok: false,
      error: { code, message: 'ignored diagnostic' }
    })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Scan Folder' }))
    await screen.findByText(/Select the directory again/)
    expect(screen.queryByText('ignored diagnostic')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scan Folder' }))
    await waitFor(() => expect(api.selectScanDirectory).toHaveBeenCalledTimes(2))
  }
)

test('shows cumulative real progress, small sizes and long paths without a percentage', async () => {
  await mount()
  const running = snapshot(1)
  emit(running)
  expect(within(panel()).getByText('1,000')).toBeVisible()
  expect(within(panel()).getByText('10', { exact: true })).toBeVisible()
  expect(within(panel()).getByText('200 MB')).toHaveAttribute('title', '200,000,000 bytes')
  expect(within(panel()).getByText(/not space allocated on disk/)).toBeVisible()
  expect(within(panel()).getByTitle(rootPath)).toHaveClass('truncate')
  expect(within(panel()).getByTitle(running.state!.progress.currentPath!)).toHaveClass('truncate')
  expect(within(panel()).queryByRole('progressbar')).not.toBeInTheDocument()
  expect(panel().textContent).not.toContain('%')
  emit({
    revision: 2,
    state: {
      ...running.state!,
      progress: { ...running.state!.progress, processedBytes: 15, currentPath: null }
    }
  })
  expect(await within(panel()).findByText('15 B')).toBeVisible()
  expect(within(panel()).queryByText(/Current path:/)).not.toBeInTheDocument()
})

test('cancels the current ID once, waits for settlement, and retains partial totals', async () => {
  await mount()
  emit(snapshot(1))
  const button = screen.getByRole('button', { name: 'Cancel Scan' })
  fireEvent.click(button)
  fireEvent.click(button)
  await screen.findByText('Cancellation requested')
  expect(api.cancelScan).toHaveBeenCalledExactlyOnceWith({ scanId: 'scan-a' })
  expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
  expect(screen.queryByText('Scan cancelled')).not.toBeInTheDocument()
  emit(snapshot(2))
  expect(screen.getByText('Cancellation requested')).toBeVisible()
  emit(snapshot(3, 'cancelled'))
  expect(screen.getByText('Scan cancelled')).toBeVisible()
  expect(within(panel()).getByText('300 MB')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
})

test('cancellation failure is safe and permits retry', async () => {
  vi.mocked(api.cancelScan).mockRejectedValue(new Error('private stack trace'))
  await mount()
  emit(snapshot(1))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Scan' }))
  await screen.findByText('Cancellation could not be requested. Please try again.')
  expect(screen.getByRole('button', { name: 'Cancel Scan' })).toBeEnabled()
  expect(panel().textContent).not.toContain('private stack trace')
})

test.each(['completed', 'cancelled', 'failed'] as const)(
  'renders confirmed final %s statistics, not an older progress sample',
  async (status) => {
    latest = snapshot(1, status)
    render(<OverviewPage />)
    await screen.findByText(
      status === 'completed'
        ? 'Scan completed'
        : status === 'cancelled'
          ? 'Scan cancelled'
          : 'Scan failed'
    )
    expect(within(panel()).getByText('1,234')).toBeVisible()
    expect(within(panel()).getByText('12', { exact: true })).toBeVisible()
    expect(within(panel()).getByText('300 MB')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
    if (status === 'failed')
      expect(within(panel()).getByRole('alert')).toHaveTextContent(
        'The scan could not be completed.'
      )
  }
)

test('completed recoverable errors label the known size as incomplete', async () => {
  latest = snapshot(1, 'completed', 'scan-a', 1)
  render(<OverviewPage />)
  await screen.findByText('Completed with errors')
  expect(within(panel()).getByText(/1 filesystem error. Results are incomplete/)).toBeVisible()
  expect(within(panel()).getByText('300 MB')).toBeVisible()
  expect(screen.getByRole('heading', { name: 'No scans yet' })).toBeVisible()
})

test('subscribes before querying and ignores older query responses and events', async () => {
  const query = deferred<ScannerIpcResult<ScanStateSnapshot>>()
  vi.mocked(api.getScanState).mockImplementationOnce(() => {
    expect(listeners.size).toBe(1)
    return query.promise
  })
  render(<OverviewPage />)
  emit(snapshot(5, 'completed', 'new-scan'))
  await act(async () => {
    query.resolve({ ok: true, value: snapshot(1) })
  })
  emit(snapshot(4))
  emit(snapshot(5))
  expect(screen.getByText('Scan completed')).toBeVisible()
  expect(screen.queryByText('Scanning')).not.toBeInTheDocument()
})

test('ignores mismatched progress IDs and late cancellation responses for another scan', async () => {
  const cancellation = deferred<Awaited<ReturnType<SpaceLensAPI['cancelScan']>>>()
  vi.mocked(api.cancelScan).mockReturnValue(cancellation.promise)
  await mount()
  emit(snapshot(1))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Scan' }))
  emit(snapshot(2, 'completed'))
  emit(snapshot(3, 'running', 'new-scan'))
  await act(async () => {
    cancellation.resolve({ ok: false, error: { code: 'SCAN_MISMATCH', message: 'old request' } })
  })
  const bad = snapshot(4, 'completed')
  emit({ ...bad, state: { ...bad.state!, progress: { ...bad.state!.progress, scanId: 'wrong' } } })
  expect(screen.getByText('Scanning')).toBeVisible()
  expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Scan' }))
  expect(api.cancelScan).toHaveBeenLastCalledWith({ scanId: 'new-scan' })
})

test('Strict Mode leaves one subscription and ignores queries from the disposed mount', async () => {
  const old = deferred<ScannerIpcResult<ScanStateSnapshot>>()
  vi.mocked(api.getScanState).mockReturnValueOnce(old.promise)
  const mounted = render(
    <StrictMode>
      <OverviewPage />
    </StrictMode>
  )
  await screen.findByText('Ready to scan')
  expect(listeners.size).toBe(1)
  await act(async () => {
    old.resolve({ ok: true, value: snapshot(100) })
  })
  expect(screen.queryByText('Scanning')).not.toBeInTheDocument()
  mounted.unmount()
  expect(listeners.size).toBe(0)
  expect(api.cancelScan).not.toHaveBeenCalled()
})

test('navigation unsubscribes without cancelling and returning retrieves the ongoing scan', async () => {
  render(<App />)
  await screen.findByText('Ready to scan')
  emit(snapshot(1))
  fireEvent.click(screen.getByRole('button', { name: 'Explorer' }))
  expect(listeners.size).toBe(0)
  expect(api.cancelScan).not.toHaveBeenCalled()
  latest = snapshot(2)
  fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
  await screen.findByText('Scanning')
  expect(api.getScanState).toHaveBeenCalledTimes(2)
  expect(listeners.size).toBe(1)
})

test('an outstanding selection cannot start scanning after its component unmounts', async () => {
  const selection = deferred<Awaited<ReturnType<SpaceLensAPI['selectScanDirectory']>>>()
  vi.mocked(api.selectScanDirectory).mockReturnValue(selection.promise)
  await mount()
  fireEvent.click(screen.getByRole('button', { name: 'Scan Folder' }))
  cleanup()
  await act(async () => {
    selection.resolve({ ok: true, value: { cancelled: false, rootPath } })
  })
  expect(api.startScan).not.toHaveBeenCalled()
})

test('transport failure never displays raw diagnostics and status loading can be retried', async () => {
  vi.mocked(api.getScanState).mockRejectedValueOnce(new Error('private internal stack'))
  render(<OverviewPage />)
  await screen.findByRole('alert')
  expect(panel().textContent).not.toContain('private internal stack')
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
  await screen.findByText('Ready to scan')
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
  expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
})

test('a delayed start response cannot turn an already completed scan back into running', async () => {
  const start = deferred<Awaited<ReturnType<SpaceLensAPI['startScan']>>>()
  vi.mocked(api.startScan).mockReturnValue(start.promise)
  await mount()
  fireEvent.click(screen.getByRole('button', { name: 'Scan Folder' }))
  await screen.findByText('Starting scan')
  emit(snapshot(1))
  emit(snapshot(2, 'completed'))
  await act(async () => {
    start.resolve({ ok: true, value: { scanId: 'scan-a' } })
  })
  expect(screen.getByText('Scan completed')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
  vi.mocked(api.startScan).mockImplementationOnce(async () => {
    emit(snapshot(3, 'running', 'scan-b'))
    return { ok: true, value: { scanId: 'scan-b' } }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Scan Folder' }))
  await screen.findByText('Scanning')
  expect(api.selectScanDirectory).toHaveBeenCalledTimes(2)
})

test('a stale initial query failure cannot obscure a newer session notification', async () => {
  const query = deferred<ScannerIpcResult<ScanStateSnapshot>>()
  vi.mocked(api.getScanState).mockReturnValueOnce(query.promise)
  render(<OverviewPage />)
  emit(snapshot(1))
  await act(async () => {
    query.reject(new Error('late failure'))
  })
  expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('Scanning')).toBeVisible()
})

test('picker failure is explained safely and allows another attempt', async () => {
  vi.mocked(api.selectScanDirectory).mockResolvedValue({
    ok: false,
    error: { code: 'PICKER_FAILED', message: 'internal diagnostic' }
  })
  await mount()
  fireEvent.click(screen.getByRole('button', { name: 'Scan Folder' }))
  await screen.findByText('The folder picker could not be opened. Please try again.')
  expect(api.startScan).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Scan Folder' })).toBeEnabled()
})

test('coalesces progress bursts and flushes terminal state without delayed stale renders', async () => {
  await mount()
  emit(snapshot(1))
  vi.useFakeTimers()
  try {
    for (let revision = 2; revision <= 50; revision++) {
      const next = snapshot(revision)
      emit({
        ...next,
        state: {
          ...next.state!,
          progress: { ...next.state!.progress, processedFileCount: revision }
        }
      })
    }
    expect(within(panel()).getByText('1,000')).toBeVisible()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(within(panel()).getByText('50', { exact: true })).toBeVisible()
    emit(snapshot(51))
    emit(snapshot(52, 'completed'))
    expect(screen.getByText('Scan completed')).toBeVisible()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(within(panel()).getByText('1,234')).toBeVisible()
    expect(screen.queryByText('Scanning')).not.toBeInTheDocument()
    emit(snapshot(53, 'running', 'next-scan'))
    emit(snapshot(54, 'running', 'next-scan'))
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('Recent Scans uses Main summaries, survives navigation and ignores stale replacement', async () => {
  const completed = {
    id: 'completed-a',
    path: '/completed directory',
    completedAt: '2026-11-11T10:01:00Z',
    totalBytes: 300,
    fileCount: 2,
    errorCount: 1
  }
  render(<App />)
  await screen.findByText('Ready to scan')
  emit({ ...snapshot(1, 'completed'), latestCompleted: completed })
  const recent = (): ReturnType<typeof within> =>
    within(screen.getByRole('region', { name: 'Recent Scans' }))
  expect(recent().getByText(completed.path)).toBeVisible()
  expect(recent().getByText('300 bytes')).toBeVisible()
  expect(recent().getByText(/Incomplete result/)).toBeVisible()
  for (const status of ['running', 'cancelled', 'failed'] as const) {
    emit({ ...snapshot(latest.revision + 1, status, 'next'), latestCompleted: completed })
    expect(recent().getByText(completed.path)).toBeVisible()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Explorer' }))
  fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
  await screen.findByText(completed.path)
  emit({
    ...snapshot(10, 'completed', 'new'),
    latestCompleted: { ...completed, id: 'new', path: '/new', errorCount: 0 }
  })
  emit({ ...snapshot(2, 'completed'), latestCompleted: completed })
  expect(recent().getByText('/new')).toBeVisible()
  expect(recent().queryByText(completed.path)).not.toBeInTheDocument()
})
