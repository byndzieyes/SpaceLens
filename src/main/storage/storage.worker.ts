import { parentPort } from 'node:worker_threads'
import { ScanDatabase } from './database'
import {
  parseStorageRequest,
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

function closeDatabase(): void {
  database?.close()
  database = undefined
}

function requireDatabase(): ScanDatabase {
  if (!database) throw new Error('Storage worker has not initialized the database.')
  return database
}

function execute(request: StorageRequest): StorageResult<StorageOperation> {
  switch (request.operation) {
    case 'initialize':
      if (database) throw new Error('Storage worker already initialized the database.')
      database = new ScanDatabase(request.payload.databasePath)
      return null
    case 'insertScan':
      requireDatabase().insertScan(request.payload)
      return null
    case 'getScan':
      return requireDatabase().getScan(request.payload.id)
    case 'insertEntry':
      requireDatabase().insertEntry(request.payload)
      return null
    case 'applyBatch':
      requireDatabase().applyBatch(request.payload.scanId, request.payload.operations)
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
