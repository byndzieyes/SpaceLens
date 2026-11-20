import type { StorageBatchOperation } from '../storage/payloads'
import { StorageWorkerError, type StorageWorkerClient } from '../storage/workerClient'
import type { ScanOutputEvent } from './summary'

export type ScanPersistence = Pick<
  StorageWorkerClient,
  'beginScan' | 'applyBatch' | 'publishScan' | 'discardBuildingScan'
>

export class ScanStorageError extends Error {
  readonly code: 'SCAN_STORAGE_FAILED' | 'SCAN_STORAGE_UNCERTAIN'

  constructor(
    action: string,
    cause: unknown,
    readonly uncertain = false
  ) {
    super(
      uncertain
        ? `SQLite did not confirm ${action}. The database outcome is unknown.`
        : `SQLite failed while ${action}.`,
      { cause }
    )
    this.name = 'ScanStorageError'
    this.code = uncertain ? 'SCAN_STORAGE_UNCERTAIN' : 'SCAN_STORAGE_FAILED'
  }
}

export async function writeScan<T>(action: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    // A worker reply establishes rollback unless SQLite itself could not roll back.
    // Transport failures and timeouts can lose the reply after a commit.
    const uncertain = !(error instanceof StorageWorkerError) || error.name === 'AggregateError'
    throw new ScanStorageError(action, error, uncertain)
  }
}

export function batchOperations(events: readonly ScanOutputEvent[]): StorageBatchOperation[] {
  const operations: StorageBatchOperation[] = []
  for (const event of events) {
    if (event.type === 'entry') operations.push(event)
    if (event.type === 'directory-finalized') {
      const { entry } = event
      if (entry.type !== 'directory' || entry.aggregatedSizeBytes === null) {
        throw new Error('Scanner finalization is missing its directory total.')
      }
      operations.push({
        type: event.type,
        entry: { ...entry, type: entry.type, aggregatedSizeBytes: entry.aggregatedSizeBytes }
      })
    }
  }
  return operations
}
