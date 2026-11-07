import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { scanDirectory } from './scan'
import { ScanCancelledError } from './cancellation'
import type { ScanOutputEvent } from './summary'
import {
  SCANNER_BATCH_SIZE,
  isScannerWorkerAck,
  isScannerWorkerCancel,
  parseScannerWorkerRequest,
  serializeWorkerFailure,
  type ScannerWorkerMessage
} from './workerProtocol'

function sendBatch(
  port: MessagePort,
  scanId: string,
  sequence: number,
  events: ScanOutputEvent[],
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      port.off('message', onMessage)
      port.off('messageerror', onError)
      port.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const onError = (error: unknown): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void =>
      onError(new Error('Scanner worker connection closed before acknowledgment.'))
    const onAbort = (): void => onError(new ScanCancelledError())
    const onMessage = (message: unknown): void => {
      // The persistent cancellation listener aborts this wait independently of acks.
      if (isScannerWorkerCancel(message, scanId)) return
      cleanup()
      if (isScannerWorkerAck(message, scanId, sequence)) resolve()
      else reject(new Error('Invalid scanner batch acknowledgment.'))
    }
    port.once('message', onMessage)
    port.once('messageerror', onError)
    port.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      port.postMessage({ type: 'batch', scanId, sequence, events } satisfies ScannerWorkerMessage)
    } catch (error) {
      onError(error)
    }
  })
}

async function run(port: MessagePort): Promise<void> {
  const { rootPath, scanId } = parseScannerWorkerRequest(workerData)
  const controller = new AbortController()
  const { signal } = controller
  const onCancel = (message: unknown): void => {
    if (isScannerWorkerCancel(message, scanId)) controller.abort(new ScanCancelledError())
  }
  port.on('message', onCancel)
  let batch: ScanOutputEvent[] = []
  let sequence = 0
  const flush = async (): Promise<void> => {
    signal.throwIfAborted()
    if (batch.length === 0) return
    const pending = batch
    batch = []
    await sendBatch(port, scanId, sequence, pending, signal)
    sequence++
  }
  try {
    for await (const event of scanDirectory(rootPath, scanId, signal)) {
      signal.throwIfAborted()
      batch.push(event)
      if (batch.length === SCANNER_BATCH_SIZE) await flush()
    }
    await flush()
    signal.throwIfAborted()
    port.postMessage({ type: 'complete', scanId } satisfies ScannerWorkerMessage)
  } catch (error) {
    if (signal.aborted) {
      port.postMessage({ type: 'cancelled', scanId } satisfies ScannerWorkerMessage)
      return
    }
    // Preserve already observed events before reporting a fatal scan failure.
    let failure = error
    try {
      await flush()
    } catch (flushError) {
      failure = flushError
    }
    if (signal.aborted) {
      port.postMessage({ type: 'cancelled', scanId } satisfies ScannerWorkerMessage)
      return
    }
    port.postMessage({
      type: 'fatal',
      scanId,
      error: serializeWorkerFailure(failure)
    } satisfies ScannerWorkerMessage)
  } finally {
    port.off('message', onCancel)
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
