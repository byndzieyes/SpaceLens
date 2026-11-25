import { parentPort } from 'node:worker_threads'
import { ScanDatabase } from './database'
import {
  parseStorageRequest,
  RECOVERY_CLOSED_CODE,
  serializeStorageFailure,
  storageRequestId,
  type StorageRequest,
  type StorageResponse,
  type StorageResult,
  type StorageOperation
} from './workerProtocol'

if (parentPort === null) throw new Error('Storage entry must execute inside a Worker Thread.')
const port = parentPort
let database: ScanDatabase | undefined
let recoveryAvailable = true

function closeDatabase(): void {
  database?.close()
  database = undefined
}

function requireDatabase(): ScanDatabase {
  if (!database) throw new Error('Storage worker has not initialized the database.')
  return database
}

function writableDatabase(): ScanDatabase {
  const db = requireDatabase()
  recoveryAvailable = false
  return db
}

function execute(request: StorageRequest): StorageResult<StorageOperation> {
  switch (request.operation) {
    case 'initialize':
      if (database) throw new Error('Storage worker already initialized the database.')
      database = new ScanDatabase(request.payload.databasePath)
      return null
    case 'recoverStorage':
      if (!recoveryAvailable) {
        throw Object.assign(
          new Error('Scan storage recovery is only available before scan writes.'),
          {
            code: RECOVERY_CLOSED_CODE
          }
        )
      }
      requireDatabase().recoverStorage()
      return null
    case 'insertScan':
      if (request.payload.status === 'completed') {
        throw new Error('Completed scans must be created through publication.')
      }
      writableDatabase().insertScan(request.payload)
      return null
    case 'beginScan':
      writableDatabase().beginScan(request.payload)
      return null
    case 'publishScan':
      return writableDatabase().publishScan(request.payload.scan, request.payload.rootEntryId)
    case 'discardBuildingScan':
      writableDatabase().discardBuildingScan(request.payload.scanId)
      return null
    case 'getPublishedScan':
      return requireDatabase().getPublishedScan()
    case 'requireValidatedScan':
      return requireDatabase().requireValidatedScan(request.payload.scanId)
    case 'listScanHistory':
      return requireDatabase().listScanHistory(request.payload)
    case 'getScanHistoryMetadata':
      return requireDatabase().getScanHistoryMetadata(request.payload)
    case 'deleteSnapshot':
      return writableDatabase().deleteSnapshot(request.payload)
    case 'getRetentionCandidate':
      return requireDatabase().getRetentionCandidate(request.payload)
    case 'pruneSnapshot':
      return writableDatabase().pruneSnapshot(request.payload)
    case 'getInsightsCategories':
      return requireDatabase().getInsightsCategories(request.payload.scanId)
    case 'getInsightsSizeDistribution':
      return requireDatabase().getInsightsSizeDistribution(request.payload.scanId)
    case 'getInsightsObservations':
      return requireDatabase().getInsightsObservations(request.payload.scanId)
    case 'listInsightsExtensions':
      return requireDatabase().listInsightsExtensions(request.payload)
    case 'listInsightsLargestFiles':
      return requireDatabase().listInsightsLargest(request.payload, 'file')
    case 'listInsightsLargestDirectories':
      return requireDatabase().listInsightsLargest(request.payload, 'directory')
    case 'getScanSnapshot':
      return requireDatabase().getScanSnapshot()
    case 'openSavedSnapshot':
      return requireDatabase().openSavedSnapshot(request.payload)
    case 'getScanEntry':
      return requireDatabase().getScanEntry(request.payload)
    case 'listScanDirectory':
      return requireDatabase().listScanDirectory(request.payload)
    case 'getScanDirectoryTreemap':
      return requireDatabase().getScanDirectoryTreemap(request.payload)
    case 'getScan':
      return requireDatabase().getScan(request.payload.id)
    case 'insertEntry': {
      const db = writableDatabase()
      db.transaction(() => {
        if (db.getScan(request.payload.scanId)?.status === 'completed') {
          throw new Error('Entries cannot be added to a completed scan.')
        }
        db.insertEntry(request.payload)
      })
      return null
    }
    case 'applyBatch':
      writableDatabase().applyBatch(request.payload.scanId, request.payload.operations)
      return null
    case 'getEntry':
      return requireDatabase().getEntry(request.payload.scanId, request.payload.id)
    case 'close':
      closeDatabase()
      return null
  }
}

function onMessage(value: unknown): void {
  const requestId = storageRequestId(value)
  // There is no safe way to correlate an error response if the envelope has no valid ID.
  if (requestId === undefined) throw new Error('Invalid storage request ID.')

  let request: StorageRequest | undefined
  let response: StorageResponse
  try {
    request = parseStorageRequest(value)
    response = { requestId, ok: true, result: execute(request) }
  } catch (error) {
    response = { requestId, ok: false, error: serializeStorageFailure(error) }
  }
  port.postMessage(response)
  if (request?.operation === 'close' || (request?.operation === 'initialize' && !database)) {
    port.off('message', onMessage)
    port.close()
  }
}

// Each handler completes its synchronous database work before the next message can execute.
port.on('message', onMessage)
port.on('messageerror', (error: unknown) => {
  throw new Error('Could not deserialize a storage request.', { cause: error })
})
port.once('close', closeDatabase)
