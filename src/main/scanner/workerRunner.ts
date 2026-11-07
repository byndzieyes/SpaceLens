import createScannerWorker from './scanner.worker?nodeWorker'
import { consumeScannerWorker, type ScanEventConsumer } from './workerClient'
import { parseScannerWorkerRequest } from './workerProtocol'
import type { ScanSummaryEvent } from './summary'

/** Resolve only after every event is consumed, completion is received, and the worker exits normally. */
export async function runScannerWorker(
  rootPath: string,
  scanId: string,
  consume: ScanEventConsumer
): Promise<ScanSummaryEvent> {
  const workerData = parseScannerWorkerRequest({ rootPath, scanId })
  const worker = createScannerWorker({ workerData })
  return consumeScannerWorker(worker, scanId, consume)
}
