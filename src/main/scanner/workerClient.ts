import type { Worker } from 'node:worker_threads'
import type { ScanProgress } from '../../shared/scan'
import { ScanProgressTracker } from './progress'
import { ScanCancelledError, SCANNER_CANCEL_TIMEOUT_MS } from './cancellation'
import type { ScanOutputEvent, ScanSummaryEvent } from './summary'
import {
  parseScannerWorkerMessage,
  type ScannerWorkerAck,
  type ScannerWorkerCancel,
  type ScannerWorkerMessage
} from './workerProtocol'

export type ScanEventConsumer = (event: ScanOutputEvent) => void | Promise<void>
export type ScanProgressConsumer = (progress: ScanProgress) => void | Promise<void>

export interface ScannerWorkerOptions {
  readonly onProgress?: ScanProgressConsumer
  readonly signal?: AbortSignal
}

/** Own a newly started worker. Only one batch is processed, and acknowledged, at a time. */
export async function consumeScannerWorker(
  worker: Worker,
  scanId: string,
  consume: ScanEventConsumer,
  options?: ScanProgressConsumer | ScannerWorkerOptions
): Promise<ScanSummaryEvent> {
  const { onProgress, signal } =
    typeof options === 'function' ? { onProgress: options } : (options ?? {})
  const progress = onProgress ? new ScanProgressTracker(scanId) : undefined
  let cancelling = false
  let cancelTimeout: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let exited = false
  let busy = false
  let complete = false
  let sequence = 0
  let summary: ScanSummaryEvent | undefined
  let resolveResult!: (result: ScanSummaryEvent) => void
  let rejectResult!: (error: unknown) => void
  const result = new Promise<ScanSummaryEvent>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const fail = (error: unknown): void => {
    if (settled) return
    settled = true
    // The first observed terminal decision wins: an accepted abort remains cancellation.
    rejectResult(cancelling ? new ScanCancelledError() : error)
  }
  const onAbort = (): void => {
    if (settled || cancelling) return
    cancelling = true
    cancelTimeout = setTimeout(() => fail(new ScanCancelledError()), SCANNER_CANCEL_TIMEOUT_MS)
    try {
      worker.postMessage({ type: 'cancel', scanId } satisfies ScannerWorkerCancel)
    } catch (error) {
      fail(error)
    }
  }
  const processBatch = async (
    message: Extract<ScannerWorkerMessage, { type: 'batch' }>
  ): Promise<void> => {
    for (const event of message.events) {
      if (settled || cancelling) return
      if (summary !== undefined)
        throw new Error('Scanner worker sent an event after the final summary.')
      if (event.type === 'summary') summary = event
      await consume(event)
      if (settled || cancelling) return
      progress?.accept(event)
    }
    if (settled || cancelling) return
    // Progress describes consumed events and shares their acknowledgment boundary.
    if (progress && onProgress) await onProgress(progress.snapshot())
    if (settled || cancelling) return
    busy = false
    sequence++
    worker.postMessage({
      type: 'ack',
      scanId,
      sequence: message.sequence
    } satisfies ScannerWorkerAck)
  }
  const onMessage = (value: unknown): void => {
    // Ignore in-flight messages after abort; only worker exit or the timeout settles it.
    if (settled || cancelling) return
    try {
      const message = parseScannerWorkerMessage(value, scanId)
      if (complete) throw new Error('Scanner worker sent a message after completion.')
      if (busy) throw new Error('Scanner worker sent a message before batch acknowledgment.')
      if (message.type === 'batch') {
        if (message.sequence !== sequence) throw new Error('Scanner worker batch is out of order.')
        busy = true
        void processBatch(message).catch(fail)
      } else if (message.type === 'fatal') {
        fail(
          Object.assign(new Error(message.error.message), {
            name: message.error.name,
            code: message.error.code
          })
        )
      } else if (message.type === 'cancelled') {
        throw new Error('Scanner worker cancelled without a cancellation request.')
      } else {
        if (summary === undefined)
          throw new Error('Scanner worker completed without a final summary.')
        complete = true
      }
    } catch (error) {
      fail(error)
    }
  }
  const onExit = (code: number): void => {
    exited = true
    if (settled) return
    if (cancelling) {
      fail(new ScanCancelledError())
      return
    }
    if (code !== 0 || !complete || busy || summary === undefined) {
      fail(new Error(`Scanner worker exited unexpectedly (code ${code}).`))
      return
    }
    settled = true
    resolveResult(summary)
  }
  worker.on('message', onMessage)
  worker.on('messageerror', fail)
  worker.on('error', fail)
  worker.on('exit', onExit)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    return await result
  } finally {
    signal?.removeEventListener('abort', onAbort)
    clearTimeout(cancelTimeout)
    try {
      if (!exited) await worker.terminate()
    } finally {
      worker.off('message', onMessage)
      worker.off('messageerror', fail)
      worker.off('error', fail)
      worker.off('exit', onExit)
    }
  }
}
