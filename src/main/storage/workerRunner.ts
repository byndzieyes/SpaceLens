import createWorker from './storage.worker?nodeWorker'
import { StorageWorkerClient } from './workerClient'

/** Start the thread. The caller provides the database path through initialize(). */
export function createStorageWorkerClient(): StorageWorkerClient {
  return new StorageWorkerClient(createWorker({ name: 'spacelens-storage' }))
}
