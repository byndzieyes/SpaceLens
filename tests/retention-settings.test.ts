// @vitest-environment node

import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { RetentionSettingsStore } from '../src/main/storage/retentionSettings'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

let directory: string
let path: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spacelens-retention-settings-'))
  path = join(directory, 'history-retention.json')
})

afterEach(async () => {
  const target = resolve(directory)
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('spacelens-retention-settings-')
  )
    throw new Error('Refusing to remove a path outside retention settings fixtures.')
  await rm(target, { recursive: true, force: true })
})

test('defaults to ten and restores valid minimum and maximum settings across restart', async () => {
  const settings = new RetentionSettingsStore(path)
  await expect(settings.get()).resolves.toEqual({ maxCompletedSnapshots: 10 })
  expect(await readdir(directory)).toEqual([])
  for (const maxCompletedSnapshots of [1, Number.MAX_SAFE_INTEGER, 4]) {
    const value = { maxCompletedSnapshots }
    await expect(settings.set(value)).resolves.toEqual(value)
    await expect(new RetentionSettingsStore(path).get()).resolves.toEqual(value)
    expect(await readdir(directory)).toEqual(['history-retention.json'])
  }
})

test('invalid input and a failed atomic replacement preserve the confirmed value', async () => {
  const settings = new RetentionSettingsStore(path)
  await settings.set({ maxCompletedSnapshots: 7 })
  const previous = await readFile(path, 'utf8')
  for (const value of [0, 2.5, Number.MAX_SAFE_INTEGER + 1, '7']) {
    await expect(settings.set({ maxCompletedSnapshots: value })).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
  }
  vi.mocked(rename).mockRejectedValueOnce(new Error('Injected rename failure'))
  await expect(settings.set({ maxCompletedSnapshots: 3 })).rejects.toMatchObject({
    code: 'INTERNAL_ERROR'
  })
  expect(await readFile(path, 'utf8')).toBe(previous)
  expect(await readdir(directory)).toEqual(['history-retention.json'])
  await expect(settings.get()).resolves.toEqual({ maxCompletedSnapshots: 7 })
})

test('invalid persisted settings suspend maintenance until an explicit valid save', async () => {
  await writeFile(path, '{"maxCompletedSnapshots":0}', 'utf8')
  const settings = new RetentionSettingsStore(path)
  await expect(settings.get()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  expect(settings.maintenanceLimit).toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe('{"maxCompletedSnapshots":0}')
  await settings.set({ maxCompletedSnapshots: 2 })
  expect(settings.maintenanceLimit).toBe(2)
})

test('serializes updates and allows an admitted save to finish at shutdown', async () => {
  const settings = new RetentionSettingsStore(path)
  const saving = settings.set({ maxCompletedSnapshots: 5 })
  expect(settings.maintenanceLimit).toBeUndefined()
  await expect(settings.set({ maxCompletedSnapshots: 1 })).rejects.toMatchObject({
    code: 'UNAVAILABLE'
  })
  await settings.stop()
  await expect(saving).resolves.toEqual({ maxCompletedSnapshots: 5 })
  await expect(settings.set({ maxCompletedSnapshots: 2 })).rejects.toMatchObject({
    code: 'UNAVAILABLE'
  })
  await expect(new RetentionSettingsStore(path).get()).resolves.toEqual({
    maxCompletedSnapshots: 5
  })
})
