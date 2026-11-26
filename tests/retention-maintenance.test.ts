// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScanStorageCoordinator } from '../src/main/storage/coordinator'
import { ScanDatabase } from '../src/main/storage/database'
import { HistoryRetention } from '../src/main/storage/historyRetention'
import type { CompletedScan } from '../src/main/storage/payloads'
import { RetentionSettingsStore } from '../src/main/storage/retentionSettings'
import { StorageWorkerError, type StorageWorkerClient } from '../src/main/storage/workerClient'
import { buildingFixture, legacyEntries, legacyScan } from './v1-scan-fixture'

class Fixture {
  readonly db = new ScanDatabase(':memory:')
  readonly discover = vi.fn<StorageWorkerClient['getRetentionCandidate']>(async (request) =>
    this.db.getRetentionCandidate(request)
  )
  readonly prune = vi.fn<StorageWorkerClient['pruneSnapshot']>(async (request) =>
    this.db.pruneSnapshot(request)
  )
  readonly begin = vi.fn<StorageWorkerClient['beginScan']>(async (scan) => this.db.beginScan(scan))
  readonly storage = new ScanStorageCoordinator(
    Promise.resolve({
      isReady: true,
      waitForExit: () => new Promise<void>(() => {}),
      beginScan: this.begin,
      applyBatch: async (scanId, entries) => this.db.applyBatch(scanId, entries),
      publishScan: async (scan, rootId) => this.db.publishScan(scan, rootId),
      discardBuildingScan: async (scanId) => this.db.discardBuildingScan(scanId),
      getScanHistoryMetadata: async (request) => this.db.getScanHistoryMetadata(request),
      deleteSnapshot: async (request) => this.db.deleteSnapshot(request),
      getRetentionCandidate: this.discover,
      pruneSnapshot: this.prune
    } satisfies Pick<
      StorageWorkerClient,
      | 'isReady'
      | 'waitForExit'
      | 'beginScan'
      | 'applyBatch'
      | 'publishScan'
      | 'discardBuildingScan'
      | 'getScanHistoryMetadata'
      | 'deleteSnapshot'
      | 'getRetentionCandidate'
      | 'pruneSnapshot'
    > as unknown as StorageWorkerClient)
  )
  readonly settings = new RetentionSettingsStore(join(directory, 'history-retention.json'))
  retention: HistoryRetention | undefined

  seed(...ids: string[]): void {
    for (const id of ids) this.db.insertScan({ ...legacyScan, id })
  }

  async start(limit = 1): Promise<HistoryRetention> {
    await this.settings.set({ maxCompletedSnapshots: limit })
    this.retention = new HistoryRetention(this.storage, this.settings)
    return this.retention
  }

  ids(): string[] {
    return this.db.listScanHistory({ sort: 'oldest' }).items.map(({ id }) => id)
  }

  async publish(id: string): Promise<CompletedScan> {
    const pending = buildingFixture(id)
    await this.storage.beginScan(pending)
    const root = { ...legacyEntries.root, scanId: id, aggregatedSizeBytes: null }
    await this.storage.applyBatch(id, [
      { type: 'entry', entry: root },
      { type: 'directory-finalized', entry: { ...root, type: 'directory', aggregatedSizeBytes: 0 } }
    ])
    return this.storage.publishScan(
      {
        ...legacyScan,
        id,
        summary: { directoryCount: 1, fileCount: 0, totalBytes: 0, errorCount: 0 }
      },
      root.id
    )
  }

  holdDiscovery(): { entered: Promise<void>; release: () => void } {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    this.discover.mockImplementationOnce(async (request) => {
      const result = this.db.getRetentionCandidate(request)
      entered.resolve()
      await gate.promise
      return result
    })
    return { entered: entered.promise, release: gate.resolve }
  }
}

let directory: string
let fixture: Fixture
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spacelens-retention-pass-'))
  fixture = new Fixture()
})
afterEach(async () => {
  await fixture.retention?.stop()
  fixture.db.close()
  const target = resolve(directory)
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('spacelens-retention-pass-')
  )
    throw new Error('Refusing to remove a path outside retention fixtures.')
  rmSync(target, { recursive: true, force: true })
})

test('coalesces startup and settings maintenance and applies the confirmed lower limit', async () => {
  fixture.seed('first', 'second', 'latest')
  const retention = await fixture.start(3)
  await vi.waitFor(() => expect(fixture.discover).toHaveBeenCalledTimes(1))
  expect(fixture.prune).not.toHaveBeenCalled()
  await retention.setSettings({ maxCompletedSnapshots: 4 })
  await vi.waitFor(() => expect(fixture.discover).toHaveBeenCalledTimes(2))
  const pruned: string[] = []
  retention.onPruned(({ scanId }) => pruned.push(scanId))
  await retention.setSettings({ maxCompletedSnapshots: 1 })
  await vi.waitFor(() => expect(pruned).toEqual(['first', 'second']))
  await vi.waitFor(() => expect(retention.status).toBe('idle'))
  expect(pruned).toEqual(['first', 'second'])
  expect(fixture.ids()).toEqual(['latest'])
  expect(fixture.prune).toHaveBeenCalledTimes(2)
})

test('defers soft overflow until the final owner releases a relevant lease', async () => {
  fixture.seed('older', 'middle', 'latest')
  const context = new AbortController()
  const explorer = fixture.storage.createSnapshotOwner(context.signal)
  const comparison = fixture.storage.createSnapshotOwner(context.signal)
  await explorer.acquire('older')
  await comparison.acquire('older')
  await comparison.acquire('middle')
  try {
    const retention = await fixture.start()
    await vi.waitFor(() => expect(retention.status).toBe('protected'))
    expect(fixture.ids()).toEqual(['older', 'middle', 'latest'])
    expect(fixture.discover).toHaveBeenCalledTimes(1)
    explorer.release('older')
    await fixture.storage.read(
      context.signal,
      (client) => client.getScanHistoryMetadata({ scanId: 'latest' }),
      'latest'
    )
    expect(fixture.discover).toHaveBeenCalledTimes(1)
    comparison.release('middle')
    await vi.waitFor(() => expect(fixture.ids()).toEqual(['older', 'latest']))
    await vi.waitFor(() => expect(retention.status).toBe('protected'))
    comparison.release('older')
    await vi.waitFor(() => expect(fixture.ids()).toEqual(['latest']))
  } finally {
    context.abort()
  }
})

test('rechecks protection when an owner acquires the discovered candidate before admission', async () => {
  fixture.seed('older', 'middle', 'latest')
  const discovery = fixture.holdDiscovery()
  const owner = fixture.storage.createSnapshotOwner(new AbortController().signal)
  try {
    const retention = await fixture.start(2)
    await discovery.entered
    const acquiring = owner.acquire('older')
    discovery.release()
    await acquiring
    await vi.waitFor(() => expect(fixture.ids()).toEqual(['older', 'latest']))
    await vi.waitFor(() => expect(retention.status).toBe('idle'))
    expect(fixture.prune.mock.calls.map(([request]) => request.scanId)).toEqual(['middle'])
  } finally {
    discovery.release()
    owner.dispose()
  }
})

test('an increased limit during discovery suppresses stale pruning', async () => {
  fixture.seed('older', 'latest')
  const discovery = fixture.holdDiscovery()
  try {
    const retention = await fixture.start()
    await discovery.entered
    await retention.setSettings({ maxCompletedSnapshots: 2 })
    discovery.release()
    await vi.waitFor(() => expect(fixture.discover).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(retention.status).toBe('idle'))
    expect(fixture.prune).not.toHaveBeenCalled()
    expect(fixture.ids()).toEqual(['older', 'latest'])
  } finally {
    discovery.release()
  }
})

test('manual deletion can make the discovered candidate Latest without pruning it', async () => {
  fixture.seed('older', 'latest')
  const discovery = fixture.holdDiscovery()
  try {
    const retention = await fixture.start()
    await discovery.entered
    const manual = fixture.storage.deleteSnapshot({ scanId: 'latest' })
    discovery.release()
    await expect(manual).resolves.toMatchObject({ latestCompletedScanId: 'older' })
    await vi.waitFor(() => expect(fixture.discover).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(retention.status).toBe('idle'))
    expect(fixture.ids()).toEqual(['older'])
  } finally {
    discovery.release()
  }
})

test('a starting scan waits for an executing cascade and prevents the next automatic deletion', async () => {
  fixture.seed('first', 'second', 'latest')
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  fixture.prune.mockImplementationOnce(async (request) => {
    entered.resolve()
    await gate.promise
    return fixture.db.pruneSnapshot(request)
  })
  try {
    const retention = await fixture.start()
    await entered.promise
    const start = fixture.storage.beginScan(buildingFixture('building'))
    expect(fixture.begin).not.toHaveBeenCalled()
    gate.resolve()
    await start
    await vi.waitFor(() => expect(retention.status).toBe('waiting'))
    expect(fixture.ids()).toEqual(['second', 'latest'])
    expect(fixture.prune).toHaveBeenCalledTimes(1)
    await fixture.storage.discardBuildingScan('building')
    await vi.waitFor(() => expect(fixture.ids()).toEqual(['latest']))
  } finally {
    gate.resolve()
  }
})

test.each(['failed', 'uncertain'] as const)(
  'confirmed publication stands when retention is %s',
  async (expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fixture.seed('older')
    const retention = await fixture.start()
    await vi.waitFor(() => expect(fixture.discover).toHaveBeenCalledOnce())
    fixture.prune.mockRejectedValueOnce(
      expected === 'uncertain'
        ? new Error('Lost acknowledgement')
        : new StorageWorkerError({
            name: 'Error',
            message: 'Rolled back',
            code: null,
            sqliteCode: null
          })
    )
    await expect(fixture.publish('latest')).resolves.toMatchObject({
      status: 'completed',
      id: 'latest'
    })
    await vi.waitFor(() => expect(retention.status).toBe(expected))
    expect(fixture.ids()).toEqual(['older', 'latest'])
    expect(fixture.prune).toHaveBeenCalledOnce()
    if (expected === 'uncertain') {
      await expect(fixture.storage.beginScan(buildingFixture('blocked'))).rejects.toThrow(
        'storage is unavailable'
      )
      await retention.setSettings({ maxCompletedSnapshots: 1 })
      expect(retention.status).toBe('uncertain')
    }
  }
)

test('an unsuccessful build creates no maintenance request after the initial check', async () => {
  fixture.seed('saved')
  const retention = await fixture.start()
  await vi.waitFor(() => expect(fixture.discover).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(retention.status).toBe('idle'))
  await fixture.storage.beginScan(buildingFixture('cancelled'))
  await fixture.storage.discardBuildingScan('cancelled')
  await fixture.storage.beginScan(buildingFixture('failed'))
  await expect(
    fixture.storage.publishScan({ ...legacyScan, id: 'failed' }, 'root')
  ).rejects.toThrow()
  await fixture.storage.discardBuildingScan('failed')
  expect(fixture.ids()).toEqual(['saved'])
  expect(fixture.discover).toHaveBeenCalledOnce()
})

test('shutdown drops pending discovery without admitting a cascade', async () => {
  fixture.seed('older', 'latest')
  const discovery = fixture.holdDiscovery()
  const retention = await fixture.start()
  await discovery.entered
  await retention.stop()
  discovery.release()
  expect(retention.status).toBe('stopped')
  expect(fixture.prune).not.toHaveBeenCalled()
  expect(fixture.ids()).toEqual(['older', 'latest'])
})
