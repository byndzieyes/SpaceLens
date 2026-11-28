/* Run from the repository using Node 24 with --experimental-transform-types. */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Standalone CommonJS benchmark loads source modules after installing the Node resolution hook. */
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { registerHooks } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { MessageChannel, Worker } = require('node:worker_threads')

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.') || path.extname(specifier)) throw error
      return next(specifier + '.ts', context)
    }
  }
})

const repo = path.resolve(__dirname, '..')
const storagePath = (file) => path.join(repo, 'src/main/storage', file + '.ts')
const { ScanDatabase } = require(storagePath('database'))
const { StorageRequestTimeoutError, StorageWorkerClient } = require(storagePath('workerClient'))
const { ScanStorageCoordinator } = require(storagePath('coordinator'))
const { readStorageTrends } = require(storagePath('readStorageTrends'))
const { fixture } = require(path.join(repo, 'tests/comparison-fixture.ts'))

function option(name, fallback) {
  const key = '--' + name + '='
  return process.argv.find((arg) => arg.startsWith(key))?.slice(key.length) ?? fallback
}

function positiveOption(name, fallback, maximum) {
  const number = Number(option(name, fallback))
  assert.ok(Number.isSafeInteger(number) && number >= 1 && number <= maximum, name)
  return number
}

const mode = option('mode', 'comparison')
const baseline = process.argv.includes('--baseline')
const coldOnly = process.argv.includes('--cold-only')
const keepProfile = process.argv.includes('--keep-profile')
const repetitions = positiveOption('reps', 2, 20)
const entries = positiveOption('entries', 100000, 1000000)
const snapshots = positiveOption('snapshots', 1000, 10000)
const batches = positiveOption('batches', 120, 1000)
const bundle = path.resolve(option('bundle', path.join(repo, 'out/main')), 'chunks')
const workerFile = fs.readdirSync(bundle).find((file) => file.startsWith('storage.worker-'))
assert.ok(workerFile, 'Build the production Worker first.')
const tmp = path.resolve(os.tmpdir())
const folder = fs.mkdtempSync(path.join(tmp, 'spacelens-phase5-bench-'))
const database = path.join(folder, 'scans.sqlite')
const pair = { baselineScanId: 'baseline', targetScanId: 'target' }
const seriesRoot = 'C:\\Archives\\Client data with a representative long root'
const noop = () => {}
const lifetime = new AbortController().signal

const round = (number) => Math.round(number * 100) / 100
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }))
const distribution = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0 }
  const percentile = (fraction) => round(sorted[Math.ceil(sorted.length * fraction) - 1])
  return {
    n: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: percentile(1)
  }
}

function comparisonFixture(id, count, target = false) {
  const specs = []
  const dir = (key) => specs.push({ key, type: 'directory' })
  const file = (key, sizeBytes) => specs.push({ key, sizeBytes })
  dir('wide')
  dir('catalog')
  dir('side')
  for (let index = 0; index < Math.floor(count * 0.45); index++)
    file('wide/item-' + index, target && index % 22 === 0 ? 751 : 500)
  for (let index = 0; index < Math.floor(count * 0.16); index++) {
    const key = 'catalog/dir-' + index
    dir(key)
    file(key + '/alpha', target && index % 13 === 0 ? 12 : 24)
    file(key + '/other', target && index % 389 === 0 ? null : 100)
  }
  for (let index = 0; index < Math.floor(count * 0.07); index++)
    file('side/' + (target ? 'new-' : 'old-') + index, index)
  dir(target ? 'empty-added' : 'empty-removed')
  let deep = 'deep'
  for (let level = 0; level < 32; level++) {
    dir(deep)
    deep += '/level'
  }
  file(deep, target ? 920 : 222)
  if (target) {
    dir('replaced')
    file('replaced/leaf', 7)
  } else file('replaced', 0)
  return fixture(id, specs, { root: seriesRoot, style: 'win32', errorCount: target ? 4 : 0 })
}

function seedComparison() {
  const db = new ScanDatabase(database)
  try {
    const left = comparisonFixture(pair.baselineScanId, entries)
    const right = comparisonFixture(pair.targetScanId, entries, true)
    const latest = fixture('newer')
    db.transaction(() => {
      for (const { scan, entries: rows } of [left, right, latest]) {
        db.insertScan(scan)
        for (const row of rows) db.insertEntry(row)
      }
    })
    return {
      entryCounts: [left.entries.length, right.entries.length],
      directories: [left.scan.summary.directoryCount, right.scan.summary.directoryCount],
      expectedBytes: right.scan.summary.totalBytes - left.scan.summary.totalBytes
    }
  } finally {
    db.close()
  }
}

// Instrument responses from the actual built Worker, including the temporary SQLite allocation.
const measurementWorker = String.raw`
  const { parentPort, workerData } = require('node:worker_threads')
  const { DatabaseSync } = require('node:sqlite')
  let start, active, db, stats
  const prepare = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function (sql) { db = this; return prepare.call(this, sql) }
  parentPort.on('message', request => { start = performance.now(); active = request })
  const send = parentPort.postMessage.bind(parentPort)
  parentPort.postMessage = message => {
    const time = performance.now() - start
    const memory = process.memoryUsage()
    let tempBytes = 0, usedTempBytes = 0
    if (db?.isOpen && /comparison/i.test(active.operation)) {
      stats ??= ['page_count', 'freelist_count', 'page_size'].map(pragma => prepare.call(db, 'PRAGMA temp.' + pragma))
      const pageCount = stats[0].get().page_count
      const free = stats[1].get().freelist_count
      const size = stats[2].get().page_size
      tempBytes = pageCount * size
      usedTempBytes = (pageCount - free) * size
    }
    workerData.port.postMessage({ id: message.requestId, time, phase: message.result?.phase, heap: memory.heapUsed, rss: memory.rss, tempBytes, usedTempBytes })
    send(message)
  }
  require(workerData.file)
`

async function open() {
  const { port1, port2 } = new MessageChannel()
  const worker = new Worker(measurementWorker, {
    eval: true,
    transferList: [port2],
    workerData: { file: path.join(bundle, workerFile), port: port2 }
  })
  const client = new StorageWorkerClient(worker)
  const byId = new Map()
  const records = []
  const original = worker.postMessage.bind(worker)
  worker.postMessage = (request) => {
    const record = { op: request.operation, request: request.payload, sent: performance.now() }
    records.push(record)
    byId.set(request.requestId, record)
    original(request)
  }
  port1.on('message', (reply) => Object.assign(byId.get(reply.id), reply))
  worker.on('message', (reply) => {
    byId.get(reply.requestId).arrived = performance.now()
  })
  const stop = async () => {
    await client.dispose().catch(noop)
    await client.waitForExit()
    port1.close()
  }
  try {
    await client.initialize(database)
    await client.recoverStorage()
    return { client, records, stop, storage: new ScanStorageCoordinator(Promise.resolve(client)) }
  } catch (error) {
    await stop()
    throw error
  }
}

function measurements(records, start) {
  const staged = records.filter((record) => record.op === 'prepareComparisonWorkspace')
  const memory = (key) => Math.max(0, ...records.map((record) => record[key] ?? 0))
  return {
    queueMs: records[0] ? round(records[0].sent - start) : null,
    executionMs: round(records.reduce((sum, record) => sum + (record.time ?? 0), 0)),
    workerRoundTripMs: round(
      records.reduce((sum, r) => sum + (r.arrived ? r.arrived - r.sent : 0), 0)
    ),
    stages: distribution(staged.map((record) => record.time)),
    stagePhases: Object.fromEntries(
      [...new Set(staged.map((record) => record.phase))]
        .filter(Boolean)
        .map((phase) => [
          phase,
          distribution(
            staged.filter((record) => record.phase === phase).map((record) => record.time)
          )
        ])
    ),
    workerHeapBytes: memory('heap'),
    processRssBytes: memory('rss'),
    tempBytes: memory('tempBytes'),
    usedTempBytes: memory('usedTempBytes')
  }
}

async function measure(session, name, query, validate = noop) {
  const offset = session.records.length
  const start = performance.now()
  let outcome = 'ok'
  try {
    const result = await query()
    validate(result)
    return result
  } catch (error) {
    outcome =
      error instanceof StorageRequestTimeoutError
        ? 'StorageRequestTimeoutError'
        : error.code || error.name
    if (!(error instanceof StorageRequestTimeoutError)) throw error
    return undefined
  } finally {
    const elapsed = performance.now() - start
    await new Promise(setImmediate)
    log(name, {
      elapsedMs: round(elapsed),
      outcome,
      ...measurements(session.records.slice(offset), start)
    })
  }
}

async function comparison() {
  const fixtureInfo = seedComparison()
  log('fixture', { ...fixtureInfo, databaseBytes: fs.statSync(database).size })
  for (let rep = 1; rep <= repetitions; rep++) {
    const session = await open()
    const { storage, client, records } = session
    try {
      log('repetition', { rep })
      const selection = baseline ? undefined : randomUUID()
      const read = (method, query, scope, current = selection, source = pair) =>
        storage.readPair(lifetime, (db) => db[method](query), source, current, scope)
      const compare = (name, method, query = {}, validate = noop) =>
        measure(
          session,
          name,
          () =>
            read(
              method,
              { ...pair, ...query },
              method.endsWith('DirectoryChanges') ? 'directories' : 'workspace'
            ),
          validate
        )
      await measure(session, 'metadata pair', () =>
        storage.readPair(
          lifetime,
          async (db) => [
            await db.getScan(pair.baselineScanId),
            await db.getScan(pair.targetScanId)
          ],
          pair
        )
      )
      for (const scanId of Object.values(pair))
        await measure(session, 'validate ' + scanId, () =>
          storage.readPair(lifetime, (db) => db.requireValidatedScan(scanId), pair)
        )
      const summary = await compare('cold Summary', 'getComparisonSummary', {}, (value) => {
        assert.equal(value.observedSnapshotBytes.delta, fixtureInfo.expectedBytes)
        assert.ok(Object.values(value.files.counts).every((count) => count > 0))
      })
      if (!summary) {
        if (baseline) assert.equal(client.isReady, false)
        if (client.isReady) {
          const latest = await storage.read(lifetime, (db) => db.getScanSnapshot())
          assert.equal(latest.snapshot?.entries.scanId, 'newer')
          log('healthy Worker after logical timeout', { latest: 'newer' })
        }
        continue
      }
      await compare('warm Summary', 'getComparisonSummary', {}, (value) =>
        assert.deepEqual(value, summary)
      )
      if (coldOnly) continue
      await compare('first Files page', 'listComparisonFileChanges', { limit: 40 })
      await compare('next Files page', 'listComparisonFileChanges', { limit: 40, offset: 40 })
      await compare('classification', 'listComparisonFileChanges', {
        kinds: ['modified', 'removed', 'indeterminate']
      })
      await compare('subtree', 'listComparisonFileChanges', {
        relativeDirectory: 'catalog',
        limit: 40
      })
      await compare('Files growth', 'listComparisonFileChanges', { sort: 'delta-desc', limit: 40 })
      await compare('Files reduction deep page', 'listComparisonFileChanges', {
        sort: 'delta-asc',
        offset: Math.floor(entries / 4)
      })
      await compare('first Directories page', 'listComparisonDirectoryChanges', { limit: 40 })
      await compare('next Directories page', 'listComparisonDirectoryChanges', {
        limit: 40,
        offset: 40
      })
      await compare('Directories growth', 'listComparisonDirectoryChanges', {
        sort: 'delta-desc',
        limit: 40
      })
      await compare('Directories reduction', 'listComparisonDirectoryChanges', {
        sort: 'delta-asc',
        limit: 40
      })
      await measure(session, 'Explorer handoff', () =>
        storage.read(
          lifetime,
          (db) => db.openSavedSnapshot(pair.baselineScanId),
          pair.baselineScanId
        )
      )
      const reverse = { baselineScanId: pair.targetScanId, targetScanId: pair.baselineScanId }
      const reversedId = selection && randomUUID()
      await measure(
        session,
        'reverse Summary',
        () => read('getComparisonSummary', reverse, 'workspace', reversedId, reverse),
        (value) => assert.equal(value.observedSnapshotBytes.delta, -fixtureInfo.expectedBytes)
      )
      if (client.isReady && !baseline) {
        await measure(session, 'workspace cleanup', async () => {
          storage.releaseComparisonWorkspace()
          await storage.read(lifetime, (db) => db.listScanHistory({ limit: 1 }))
        })
        const last = records.filter((r) => r.request?.action === 'discard').at(-1)
        assert.ok(last)
      }
    } finally {
      await session.stop()
    }
  }
}

function seedTrends() {
  const db = new ScanDatabase(database)
  const latest = fixture('latest', [], { root: seriesRoot, style: 'win32' })
  let seriesCount = 1
  try {
    db.transaction(() => {
      for (let index = 0; index < snapshots - 1; index++) {
        const variant = index % 6
        const rootPath =
          variant < 2
            ? variant === 0
              ? seriesRoot
              : seriesRoot.toLowerCase()[0] + seriesRoot.slice(1).replaceAll('\\', '/') + '/'
            : variant === 2
              ? '//opaque/unknown-semantics'
              : 'D:\\Another archival directory\\Collection ' + variant
        if (variant < 2) seriesCount++
        db.insertScan({
          ...latest.scan,
          id: 'series-' + index,
          rootPath,
          summary: { ...latest.scan.summary, errorCount: index % 11 === 0 ? 1 : 0 }
        })
      }
      db.insertScan(latest.scan)
      for (const row of latest.entries) db.insertEntry(row)
    })
    return seriesCount
  } finally {
    db.close()
  }
}

async function trends() {
  const count = seedTrends()
  const session = await open()
  try {
    const { storage, records } = session
    const validate = (result) => {
      assert.equal(result.retainedCount, count)
      assert.equal(result.points.length, Math.min(count, 100))
      assert.equal(result.points.at(-1).id, 'latest')
    }
    const sizes = []
    for (let rep = 0; rep < repetitions; rep++) {
      const offset = records.length
      const data = await measure(
        session,
        'Trends latest',
        () => readStorageTrends(storage, lifetime, { mode: 'latest' }),
        validate
      )
      sizes.push(records.length - offset)
      await measure(session, 'Trends other root', () =>
        readStorageTrends(storage, lifetime, { mode: 'snapshot', scanId: 'series-3' })
      )
      assert.ok(data?.series)
    }
    log('Trends size', {
      snapshots,
      count,
      batches: sizes,
      timings: distribution(records.filter((r) => r.op === 'readTrendBatch').map((r) => r.time))
    })
    for (const [name, query] of [
      ['history recent', { limit: 20 }],
      ['history exact path', { rootPath: seriesRoot, limit: 20 }],
      ['history literal substring', { rootPathContains: 'archival directory', limit: 20 }],
      [
        'history size / deep offset',
        { sort: 'size-desc', offset: Math.floor(snapshots / 2), limit: 20 }
      ]
    ])
      await measure(session, name, () => storage.read(lifetime, (db) => db.listScanHistory(query)))
    const scan = fixture('active')
    const root = { ...scan.entries[0], aggregatedSizeBytes: null }
    for (const overlap of [false, true]) {
      const started = performance.now()
      let scanning = true
      let reads = 0
      const acknowledgements = []
      await storage.beginScan(scan.building)
      await storage.applyBatch(scan.scan.id, [{ type: 'entry', entry: root }])
      const whileScanning = overlap
        ? (async () => {
            while (scanning) {
              const result = await readStorageTrends(storage, lifetime, { mode: 'latest' })
              validate(result)
              reads++
            }
          })()
        : Promise.resolve()
      try {
        for (let batch = 0; batch < batches; batch++) {
          const operations = Array.from({ length: 128 }, (_, index) => ({
            type: 'entry',
            entry: {
              ...root,
              id: 'entry-' + (batch * 128 + index),
              parentId: root.id,
              type: 'file',
              name: 'item-' + (batch * 128 + index),
              path: '/comparison/item-' + (batch * 128 + index),
              sizeBytes: 0
            }
          }))
          const start = performance.now()
          await storage.applyBatch(scan.scan.id, operations)
          acknowledgements.push(performance.now() - start)
          // Real scanner batches arrive in separate Worker messages. Model that dispatch gap.
          await new Promise(setImmediate)
        }
      } finally {
        scanning = false
        await whileScanning
        await storage.discardBuildingScan(scan.scan.id)
      }
      log('scanner acknowledgements', {
        overlap,
        reads,
        batches,
        elapsedMs: round(performance.now() - started),
        latencyMs: distribution(acknowledgements)
      })
    }
  } finally {
    await session.stop()
  }
}

function mainAllocation() {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    return {
      pageCount: db.prepare('PRAGMA main.page_count').get().page_count,
      pageSize: db.prepare('PRAGMA main.page_size').get().page_size,
      freePages: db.prepare('PRAGMA main.freelist_count').get().freelist_count
    }
  } finally {
    db.close()
  }
}

async function lifecycle() {
  const fixtureInfo = seedComparison()
  const before = mainAllocation()
  const deletion = await open()
  try {
    await measure(
      deletion,
      'large snapshot delete',
      () => deletion.storage.deleteSnapshot({ scanId: pair.baselineScanId }),
      (result) => assert.equal(result.latestCompletedScanId, 'newer')
    )
  } finally {
    await deletion.stop()
  }
  const deleted = mainAllocation()
  assert.ok(deleted.freePages > before.freePages)
  const reuse = await open()
  try {
    const { storage } = reuse
    const next = fixture(
      'reuse',
      Array.from({ length: 2000 }, (_, n) => ({ key: 'file-' + n }))
    )
    const [root] = next.entries
    await storage.beginScan(next.building)
    await storage.applyBatch(next.scan.id, [
      { type: 'entry', entry: { ...root, aggregatedSizeBytes: null } }
    ])
    for (let offset = 1; offset < next.entries.length; offset += 128) {
      const operations = next.entries
        .slice(offset, offset + 128)
        .map((entry) => ({ type: 'entry', entry }))
      await storage.applyBatch(next.scan.id, operations)
    }
    await storage.applyBatch(next.scan.id, [{ type: 'directory-finalized', entry: root }])
    await storage.publishScan(next.scan, root.id)
    assert.deepEqual(
      (await storage.read(lifetime, (db) => db.listScanHistory({ limit: 10 }))).items.map(
        ({ id }) => id
      ),
      ['reuse', 'newer', 'target']
    )
  } finally {
    await reuse.stop()
  }
  const reused = mainAllocation()
  assert.equal(reused.pageCount, deleted.pageCount)
  assert.ok(reused.freePages < deleted.freePages)
  log('SQLite freelist reuse', { fixture: fixtureInfo.entryCounts, before, deleted, reused })
}

log('runtime', {
  node: process.version,
  os: os.release(),
  cpu: os.cpus()[0]?.model,
  parallelism: os.availableParallelism(),
  mode,
  baseline
})
const run = { comparison, trends, lifecycle }[mode]
assert.ok(run, 'Unknown benchmark mode.')
run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    assert.equal(path.dirname(folder), tmp)
    assert.ok(path.basename(folder).startsWith('spacelens-phase5-bench-'))
    if (keepProfile) log('disposable profile', { folder })
    else fs.rmSync(folder, { recursive: true, force: true })
  })
