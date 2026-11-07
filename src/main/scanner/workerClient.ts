import type { Worker } from 'node:worker_threads'
import type { ScanOutputEvent, ScanSummaryEvent } from './summary'
import {
  parseScannerWorkerMessage,
  type ScannerWorkerAck,
  type ScannerWorkerMessage
} from './workerProtocol'

export type ScanEventConsumer = (event: ScanOutputEvent) => void | Promise<void>

/** Own a newly started worker. Only one batch is processed, and acknowledged, at a time. */
export async function consumeScannerWorker(
  worker: Worker,
  scanId: string,
  consume: ScanEventConsumer
): Promise<ScanSummaryEvent> {
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
    rejectResult(error)
  }
  const processBatch = async (
    message: Extract<ScannerWorkerMessage, { type: 'batch' }>
  ): Promise<void> => {
    for (const event of message.events) {
      if (settled) return
      if (summary !== undefined)
        throw new Error('Scanner worker sent an event after the final summary.')
      if (event.type === 'summary') summary = event
      await consume(event)
    }
    if (settled) return
    busy = false
    sequence++
    worker.postMessage({
      type: 'ack',
      scanId,
      sequence: message.sequence
    } satisfies ScannerWorkerAck)
  }
  const onMessage = (value: unknown): void => {
    if (settled) return
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
  try {
    return await result
  } finally {
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
