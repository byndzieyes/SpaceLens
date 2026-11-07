import createScannerWorker from './scanner.worker?nodeWorker'
import {
  consumeScannerWorker,
  type ScanEventConsumer,
  type ScanProgressConsumer
} from './workerClient'
import { parseScannerWorkerRequest } from './workerProtocol'
import type { ScanSummaryEvent } from './summary'

/**
 * Resolve only after every event/progress callback finishes, completion is received,
 * and the worker exits normally. Optional progress runs once per consumed batch
 * (including the final partial batch), before acknowledgment. It reports known
 * work only, including on partial failures; await the result to establish success.
 */
export async function runScannerWorker(
  rootPath: string,
  scanId: string,
  consume: ScanEventConsumer,
  onProgress?: ScanProgressConsumer
): Promise<ScanSummaryEvent> {
  const workerData = parseScannerWorkerRequest({ rootPath, scanId })
  const worker = createScannerWorker({ workerData })
  return consumeScannerWorker(worker, scanId, consume, onProgress)
}
