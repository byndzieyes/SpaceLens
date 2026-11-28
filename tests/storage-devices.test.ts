// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createStorageDeviceReader } from '../src/main/storageDevices'

const { execute } = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { signal: AbortSignal },
        callback: (
          error: { killed?: boolean; code?: string | number | null } | null,
          stdout: string
        ) => void
      ) => void
    >()
}))
vi.mock('node:child_process', () => ({ execFile: execute }))

beforeEach(() => {
  execute.mockReset()
  vi.stubEnv('SystemRoot', 'C:\\Windows')
})
afterEach(() => vi.unstubAllEnvs())

const drive = { id: 'C:', type: 3, label: 'System', total: '476000000000', free: '94000000000' }

function stdout(value: string): void {
  execute.mockImplementationOnce((_file, _args, _options, callback) => callback(null, value))
}

test('reads a fixed drive with a bounded, hidden Windows PowerShell CIM query', async () => {
  stdout(JSON.stringify([drive]))
  const reader = createStorageDeviceReader('win32')
  await expect(reader.read()).resolves.toEqual([
    {
      id: 'C:',
      rootPath: 'C:\\',
      type: 'fixed',
      volumeLabel: 'System',
      capacity: {
        totalBytes: '476000000000',
        usedBytes: '382000000000',
        freeBytes: '94000000000',
        usedPercentage: 80.3
      }
    }
  ])
  expect(execute).toHaveBeenCalledWith(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringContaining('DriveType = 2 OR DriveType = 3')
    ],
    expect.objectContaining({
      timeout: 5_000,
      maxBuffer: 65_536,
      windowsHide: true,
      encoding: 'utf8'
    }),
    expect.any(Function)
  )
})

test('discovers local and removable drives, preserves labels, and omits other types', async () => {
  stdout(
    JSON.stringify([
      { ...drive, id: 'q:', label: 'Зовнішній диск', type: 2 },
      { ...drive, id: 'Z:', type: 4 },
      { ...drive, id: 'A:', label: '  ' },
      { ...drive, id: 'W:', type: 5 },
      { ...drive, id: 'R:', label: null, type: 2, total: null, free: null }
    ])
  )
  const devices = await createStorageDeviceReader('win32').read()
  expect(devices.map(({ id }) => id)).toEqual(['A:', 'Q:', 'R:'])
  expect(devices[0]).toMatchObject({ volumeLabel: null, rootPath: 'A:\\', type: 'fixed' })
  expect(devices[1]).toMatchObject({
    volumeLabel: 'Зовнішній диск',
    rootPath: 'Q:\\',
    type: 'removable'
  })
  expect(devices[2]).toMatchObject({ capacity: null, type: 'removable' })
})

test.each([
  ['0', '0', '0', 0],
  ['1000', '0', '1000', 100],
  ['1000', '1000', '0', 0],
  ['256000000000', '128000000000', '128000000000', 50],
  ['18446744073709551615', '18446744073709551614', '1', 0],
  ['18446744073709551615', '1', '18446744073709551614', 100]
])(
  'preserves exact capacity %s and free bytes %s',
  async (total, free, usedBytes, usedPercentage) => {
    stdout(JSON.stringify([{ ...drive, total, free }]))
    const [device] = await createStorageDeviceReader('win32').read()
    expect(device.capacity).toEqual({
      totalBytes: total,
      freeBytes: free,
      usedBytes,
      usedPercentage
    })
  }
)

test.each([
  [-1, '0'],
  ['-1', '0'],
  ['100', '101'],
  ['0', '1'],
  ['100', '-1'],
  ['1.5', '1'],
  ['1e3', '1'],
  ['18446744073709551616', '1'],
  ['100', null],
  ['100', 'NaN'],
  ['Infinity', '1']
])(
  'marks contradictory or invalid capacity %s and free bytes %s unavailable',
  async (total, free) => {
    stdout(JSON.stringify([{ ...drive, total, free }]))
    const [device] = await createStorageDeviceReader('win32').read()
    expect(device.capacity).toBeNull()
  }
)

test('treats an empty list as successful discovery', async () => {
  stdout('[]')
  await expect(createStorageDeviceReader('win32').read()).resolves.toEqual([])
})

test.each(['', 'junk', '[null]', '{}', '[{"id":"bad","type":3,"label":null}]'])(
  'rejects malformed output %j',
  async (output) => {
    stdout(output)
    await expect(createStorageDeviceReader('win32').read()).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    })
  }
)

test.each([
  [{ code: 1 }, 'UNAVAILABLE'],
  [{ code: 'ENOENT' }, 'UNAVAILABLE'],
  [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'UNAVAILABLE'],
  [{ code: null, killed: true }, 'TIMEOUT']
])('maps subprocess errors to sanitized outcomes and allows retry', async (error, code) => {
  execute.mockImplementationOnce((_file, _args, _options, callback) =>
    callback(error, 'private output')
  )
  const reader = createStorageDeviceReader('win32')
  await expect(reader.read()).rejects.toMatchObject({ code, message: code })
  stdout('[]')
  await expect(reader.read()).resolves.toEqual([])
})

test('shares one in-flight request and aborts it at shutdown', async () => {
  const reader = createStorageDeviceReader('win32')
  execute.mockImplementationOnce((_file, _args, { signal }, callback) => {
    signal.addEventListener('abort', () => callback({ code: 'ABORT_ERR' }, ''), { once: true })
  })
  const first = reader.read()
  expect(reader.read()).toBe(first)
  expect(execute).toHaveBeenCalledTimes(1)
  reader.dispose()
  await expect(first).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await expect(reader.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  expect(execute).toHaveBeenCalledTimes(1)
})

test('does not invoke PowerShell on unsupported platforms', async () => {
  await expect(createStorageDeviceReader('linux').read()).rejects.toMatchObject({
    code: 'UNSUPPORTED_PLATFORM'
  })
  expect(execute).not.toHaveBeenCalled()
})
