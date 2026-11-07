import createScannerWorker from './scanner.worker?nodeWorker'
import {
  consumeScannerWorker,
  type ScanEventConsumer,
  type ScanProgressConsumer,
  type ScannerWorkerOptions
} from './workerClient'
import { ScanCancelledError } from './cancellation'
export { ScanCancelledError } from './cancellation'
export type { ScannerWorkerOptions } from './workerClient'
import { parseScannerWorkerRequest } from './workerProtocol'
import type { ScanSummaryEvent } from './summary'

/**
 * Resolve only after every event/progress callback finishes, completion is received,
 * and the worker exits normally. Optional progress runs once per consumed batch
 * (including the final partial batch), before acknowledgment. It reports known
 * work only, including on partial failures; await the result to establish success.
 * An abort observed before settlement wins over later completion/failure. Already
 * running callbacks cannot be interrupted, but no further callbacks/acks start.
 * Rejects with ScanCancelledError after worker cleanup; partial consumer data stays
 * with the caller. Aborting after settlement has no effect.
 */
export async function runScannerWorker(
  rootPath: string,
  scanId: string,
  consume: ScanEventConsumer,
  options?: ScanProgressConsumer | ScannerWorkerOptions
): Promise<ScanSummaryEvent> {
  if (typeof options !== 'function' && options?.signal?.aborted) throw new ScanCancelledError()
  const workerData = parseScannerWorkerRequest({ rootPath, scanId })
  const worker = createScannerWorker({ workerData })
  return consumeScannerWorker(worker, scanId, consume, options)
}
