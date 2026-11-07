import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { scanDirectory } from './scan'
import type { ScanOutputEvent } from './summary'
import {
  SCANNER_BATCH_SIZE,
  isScannerWorkerAck,
  parseScannerWorkerRequest,
  serializeWorkerFailure,
  type ScannerWorkerMessage
} from './workerProtocol'

function sendBatch(
  port: MessagePort,
  scanId: string,
  sequence: number,
  events: ScanOutputEvent[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      port.off('message', onMessage)
      port.off('messageerror', onError)
      port.off('close', onClose)
    }
    const onError = (error: unknown): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void =>
      onError(new Error('Scanner worker connection closed before acknowledgment.'))
    const onMessage = (message: unknown): void => {
      cleanup()
      if (isScannerWorkerAck(message, scanId, sequence)) resolve()
      else reject(new Error('Invalid scanner batch acknowledgment.'))
    }
    port.once('message', onMessage)
    port.once('messageerror', onError)
    port.once('close', onClose)
    try {
      port.postMessage({ type: 'batch', scanId, sequence, events } satisfies ScannerWorkerMessage)
    } catch (error) {
      onError(error)
    }
  })
}

async function run(port: MessagePort): Promise<void> {
  const { rootPath, scanId } = parseScannerWorkerRequest(workerData)
  let batch: ScanOutputEvent[] = []
  let sequence = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const pending = batch
    batch = []
    await sendBatch(port, scanId, sequence, pending)
    sequence++
  }
  try {
    for await (const event of scanDirectory(rootPath, scanId)) {
      batch.push(event)
      if (batch.length === SCANNER_BATCH_SIZE) await flush()
    }
    await flush()
    port.postMessage({ type: 'complete', scanId } satisfies ScannerWorkerMessage)
  } catch (error) {
    // Preserve already observed events before reporting a fatal scan failure.
    let failure = error
    try {
      await flush()
    } catch (flushError) {
      failure = flushError
    }
    port.postMessage({
      type: 'fatal',
      scanId,
      error: serializeWorkerFailure(failure)
    } satisfies ScannerWorkerMessage)
  } finally {
    port.close()
  }
}

if (parentPort === null) throw new Error('Scanner entry must execute inside a Worker Thread.')
const port = parentPort
void run(port).catch(() => {
  // Transport/startup failures that cannot be delivered still produce a failed exit.
  port.close()
  process.exitCode = 1
})
