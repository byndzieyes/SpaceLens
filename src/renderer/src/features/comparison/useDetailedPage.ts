import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type {
  ComparisonErrorCode,
  ComparisonPair,
  ComparisonReadRequest
} from '../../../../shared/comparison'
import type { ScannerIpcResult } from '../../../../shared/ipc'

export class DetailedQueryQueue {
  private readonly pending = new Map<symbol, () => Promise<void>>()
  private reading = false

  enqueue(slot: symbol, read: () => Promise<void>): () => void {
    this.pending.set(slot, read)
    if (!this.reading) {
      this.reading = true
      queueMicrotask(() => void this.drain())
    }
    return () => {
      if (this.pending.get(slot) === read) this.pending.delete(slot)
    }
  }

  private async drain(): Promise<void> {
    for (const [slot, read] of this.pending) {
      this.pending.delete(slot)
      await read()
    }
    this.reading = false
  }
}

type DetailState<Result> =
  | { status: 'idle'; value?: undefined }
  | { status: 'loading'; value?: Result }
  | { status: 'ready'; value: Result }
  | { status: 'error'; code: ComparisonErrorCode; value?: Result }

export function useDetailedPage<
  Query extends ComparisonPair & { offset: number; limit: number },
  Result extends { pair: ComparisonPair; offset: number; limit: number }
>(
  queue: DetailedQueryQueue,
  request: ComparisonReadRequest<Query>,
  read: (
    request: ComparisonReadRequest<Query>
  ) => Promise<ScannerIpcResult<Result, ComparisonErrorCode>>,
  enabled: boolean,
  scanActive: boolean | undefined
): { state: DetailState<Result>; retry: () => void } {
  const [version, setVersion] = useState(0)
  const [slot] = useState(() => Symbol())
  type Settled = {
    request: typeof request
    version: number
    state: DetailState<Result>
  }
  const [settled, setSettled] = useState<Settled>()
  const completed = useRef<Settled>(undefined)
  const mounted = useRef(false)
  const scanIsActive = useEffectEvent(() => scanActive === true)
  const matches = useEffectEvent(
    (source: typeof request, attempt: number) => source === request && attempt === version
  )

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const current = (): boolean => mounted.current && matches(request, version)
    const publish = (state: DetailState<Result>): void => {
      if (!current()) return
      const result = { request, version, state }
      completed.current = result
      setSettled(result)
    }
    const fail = (code: ComparisonErrorCode): void =>
      publish({
        status: 'error',
        code,
        value: completed.current?.request === request ? completed.current.state.value : undefined
      })
    return queue.enqueue(slot, async () => {
      if (
        !current() ||
        (completed.current?.request === request && completed.current.version === version)
      )
        return
      if (scanIsActive()) {
        fail('COMPARISON_SCAN_ACTIVE')
        return
      }
      try {
        const reply = await read(request)
        if (!current()) return
        if (!reply.ok) {
          fail(reply.error.code)
          return
        }
        const value = reply.value
        if (
          value.pair.baselineScanId !== request.query.baselineScanId ||
          value.pair.targetScanId !== request.query.targetScanId ||
          value.offset !== request.query.offset ||
          value.limit !== request.query.limit
        ) {
          fail('INTERNAL_ERROR')
          return
        }
        publish({ status: 'ready', value })
      } catch {
        fail('UNAVAILABLE')
      }
    })
  }, [enabled, queue, read, request, slot, version])

  const current = settled?.request === request ? settled : undefined
  return {
    state:
      current?.version === version
        ? current.state
        : enabled
          ? { status: 'loading', value: current?.state.value }
          : { status: 'idle' },
    retry: () => setVersion((value) => value + 1)
  }
}
