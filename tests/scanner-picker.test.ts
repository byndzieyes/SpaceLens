// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, opendir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC_CHANNELS } from '../src/shared/ipc'
import { registerScannerIpc } from '../src/main/scannerIpc'
import type { ScanSessionManager } from '../src/main/scanner/sessionManager'
import type { ScanSessionState } from '../src/shared/scan'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, opendir: vi.fn(fs.opendir) }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: new EventEmitter(),
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
    BrowserWindow: { fromWebContents: vi.fn() },
    dialog: { showOpenDialog: vi.fn() }
  }
})

let fixture: string
let selected: string
let state: ScanSessionState | null
let boundary: ReturnType<typeof registerScannerIpc>
let renderer: EventEmitter & {
  mainFrame: { url: string }
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
}
let start: ReturnType<typeof vi.fn>
const url = 'file:///app/index.html'
const owner = { isDestroyed: () => false }

function event(): IpcMainInvokeEvent {
  return { sender: renderer, senderFrame: renderer.mainFrame } as unknown as IpcMainInvokeEvent
}
function invoke(channel: string, args: unknown[] = [], sender = event()): unknown {
  return vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([name]) => name === channel)![1](sender, ...args)
}
async function pick(path = selected): Promise<unknown> {
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [path] })
  return invoke(IPC_CHANNELS.selectScanDirectory)
}
function request(path = selected): unknown {
  return invoke(IPC_CHANNELS.startScan, [{ rootPath: path }])
}

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'spacelens-picker-')))
  selected = join(fixture, 'selected folder Україна')
  await mkdir(selected)
  state = null
  renderer = Object.assign(new EventEmitter(), {
    mainFrame: { url },
    isDestroyed: () => false,
    send: vi.fn()
  })
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(owner as Electron.BrowserWindow)
  start = vi.fn(async (rootPath: string) => {
    state = {
      session: {
        id: '11111111-1111-4111-8111-111111111111',
        rootPath,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary: { fileCount: 0, directoryCount: 0, totalBytes: 0, errorCount: 0 }
      },
      progress: {
        scanId: '11111111-1111-4111-8111-111111111111',
        processedFileCount: 0,
        processedDirectoryCount: 0,
        processedBytes: 0,
        currentPath: null
      },
      failure: null
    }
    return state
  })
  boundary = registerScannerIpc(
    {
      getState: () => state,
      start,
      cancel: vi.fn(),
      subscribe: () => () => {},
      dispose: async () => {}
    } as unknown as ScanSessionManager,
    url
  )
  boundary.attachRenderer(renderer as unknown as WebContents)
})
afterEach(async () => {
  await boundary.dispose()
  ipcMain.removeAllListeners()
  vi.clearAllMocks()
  const target = resolve(fixture)
  if (
    dirname(target) !== (await realpath(tmpdir())) ||
    !basename(target).startsWith('spacelens-picker-')
  )
    throw new Error('Unsafe fixture cleanup')
  await rm(target, { recursive: true, force: true })
})

test('selects one accessible empty directory in the owner window without starting a scan', async () => {
  expect(await pick()).toEqual({ ok: true, value: { cancelled: false, rootPath: selected } })
  expect(dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(owner, {
    title: 'Select a directory to scan',
    properties: ['openDirectory']
  })
  expect(start).not.toHaveBeenCalled()
  expect(await request()).toMatchObject({ ok: true })
  expect(start).toHaveBeenCalledExactlyOnceWith(selected)
})
test('cancellation is a normal result and grants no new permission', async () => {
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await invoke(IPC_CHANNELS.selectScanDirectory)).toEqual({
    ok: true,
    value: { cancelled: true }
  })
  expect(await request()).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
  expect(start).not.toHaveBeenCalled()
})
test('dialog failure is sanitized and grants no permission', async () => {
  vi.mocked(dialog.showOpenDialog).mockRejectedValue(new Error('private internal details'))
  expect(await invoke(IPC_CHANNELS.selectScanDirectory)).toMatchObject({
    ok: false,
    error: { code: 'PICKER_FAILED' }
  })
  expect(await request()).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
})
test('rejects picker arguments and unauthorized frames before opening a dialog', async () => {
  expect(await invoke(IPC_CHANNELS.selectScanDirectory, [{}])).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' }
  })
  for (const sender of [
    { ...event(), senderFrame: null },
    { ...event(), senderFrame: { url } },
    { ...event(), sender: {} }
  ]) {
    expect(
      await invoke(IPC_CHANNELS.selectScanDirectory, [], sender as IpcMainInvokeEvent)
    ).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
  }
  expect(dialog.showOpenDialog).not.toHaveBeenCalled()
})
test('only the exact returned path is authorized, not parents, siblings, children, or normalized variants', async () => {
  await pick()
  for (const path of [
    fixture,
    join(fixture, 'sibling'),
    join(selected, 'child'),
    selected + '/../' + basename(selected),
    selected + '/.',
    selected + '/'
  ]) {
    expect(await request(path)).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
  }
  expect(start).not.toHaveBeenCalled()
})
test.each(['removed', 'replaced', 'file'] as const)(
  'revokes approval when the selected directory is %s',
  async (kind) => {
    await pick()
    // Rename preserves the original inode, making replacement detection deterministic.
    await rename(selected, join(fixture, 'original'))
    if (kind === 'replaced') await mkdir(selected)
    if (kind === 'file') await writeFile(selected, 'data')
    expect(await request()).toMatchObject({ ok: false, error: { code: 'DIRECTORY_UNAVAILABLE' } })
    expect(await request()).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
    expect(start).not.toHaveBeenCalled()
  }
)
test('rejects missing paths and regular files from a dialog without creating a session', async () => {
  await writeFile(join(fixture, 'file'), 'x')
  for (const path of [join(fixture, 'missing'), join(fixture, 'file'), 'relative'])
    expect(await pick(path)).toMatchObject({ ok: false, error: { code: 'DIRECTORY_UNAVAILABLE' } })
  expect(start).not.toHaveBeenCalled()
})

test.each(['selection', 'start'] as const)(
  'denied directory access during %s does not authorize a scan',
  async (phase) => {
    if (phase === 'start') await pick()
    vi.mocked(opendir).mockRejectedValueOnce(
      Object.assign(new Error('Private filesystem details'), { code: 'EACCES' })
    )
    const result = phase === 'selection' ? await pick() : await request()
    expect(result).toMatchObject({ ok: false, error: { code: 'DIRECTORY_UNAVAILABLE' } })
    expect(JSON.stringify(result)).not.toContain('Private filesystem details')
    expect(await request()).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
    expect(start).not.toHaveBeenCalled()
  }
)
test('supports nested directories and filesystem roots without scanning automatically', async () => {
  const nested = join(selected, 'nested')
  await mkdir(nested)
  expect(await pick(nested)).toMatchObject({ ok: true, value: { rootPath: nested } })
  const root = parse(fixture).root
  expect(await pick(root)).toEqual({
    ok: true,
    value: { cancelled: false, rootPath: await realpath(root) }
  })
  expect(start).not.toHaveBeenCalled()
})
test('resolves a selected directory link or junction to its explicit canonical target', async (context) => {
  const link = join(fixture, 'link')
  try {
    await symlink(selected, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip()
      return
    }
    throw error
  }
  expect(await pick(link)).toEqual({ ok: true, value: { cancelled: false, rootPath: selected } })
  expect(await request(link)).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
  expect(await request()).toMatchObject({ ok: true })
})
test.each(['destroyed', 'navigation', 'dispose'] as const)(
  'discards an outstanding picker result after %s and prevents overlapping dialogs',
  async (change) => {
    let finish!: (result: Electron.OpenDialogReturnValue) => void
    vi.mocked(dialog.showOpenDialog).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const pending = invoke(IPC_CHANNELS.selectScanDirectory)
    expect(await invoke(IPC_CHANNELS.selectScanDirectory)).toMatchObject({
      ok: false,
      error: { code: 'PICKER_BUSY' }
    })
    if (change === 'destroyed') renderer.emit('destroyed')
    if (change === 'navigation') renderer.emit('did-start-navigation', { isMainFrame: true })
    if (change === 'dispose') await boundary.dispose()
    finish({ canceled: false, filePaths: [selected] })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
    expect(start).not.toHaveBeenCalled()
  }
)
test('context changes revoke approvals, including reloads returning to the same URL', async () => {
  await pick()
  renderer.emit('did-start-navigation', { isMainFrame: true })
  expect(await request()).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
  await pick()
  boundary.attachRenderer(renderer as unknown as WebContents)
  expect(await request()).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
})
test('cancelling keeps the previous explicitly selected directory authorized', async () => {
  await pick()
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await invoke(IPC_CHANNELS.selectScanDirectory)).toEqual({
    ok: true,
    value: { cancelled: true }
  })
  expect(await request()).toMatchObject({ ok: true })
  expect(start).toHaveBeenCalledExactlyOnceWith(selected)
})

test('a new successful selection replaces the old approval', async () => {
  await pick()
  const other = join(fixture, 'other')
  await mkdir(other)
  await pick(other)
  expect(await request()).toMatchObject({ ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } })
  expect(await request(other)).toMatchObject({ ok: true })
})
test('concurrent start validations cannot create two scans and selection does not replace an active scan', async () => {
  await pick()
  const pending = request()
  expect(await request()).toMatchObject({ ok: false, error: { code: 'SCAN_ACTIVE' } })
  expect(await pending).toMatchObject({ ok: true })
  const before = state
  const other = join(fixture, 'other')
  await mkdir(other)
  await pick(other)
  expect(state).toBe(before)
  expect(await request(other)).toMatchObject({ ok: false, error: { code: 'SCAN_ACTIVE' } })
  expect(start).toHaveBeenCalledOnce()
})
