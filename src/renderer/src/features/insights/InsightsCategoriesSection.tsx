import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { InsightsCategories } from '../../../../shared/insights'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { CategoryDonut } from './CategoryDonut'

type CategoryState =
  | { status: 'loading' }
  | { status: 'error'; expired: boolean }
  | { status: 'ready'; data: InsightsCategories }

function useInsightsCategories(
  scanId: string,
  recheckPublication: (scanId: string) => Promise<void>
): { state: CategoryState; retry: () => void } {
  const [state, setState] = useState<CategoryState>({ status: 'loading' })
  const retry = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    let active = true
    let pending = false
    const fail = (detail: unknown, expired = false): void => {
      if (!active) return
      if (import.meta.env.DEV) console.warn('Could not load Insights file categories.', detail)
      setState({ status: 'error', expired })
    }
    const load = async (): Promise<void> => {
      if (!active || pending) return
      pending = true
      setState({ status: 'loading' })
      try {
        const result = await window.spaceLens.getInsightsCategories({ scanId })
        if (!active) return
        if (!result.ok) {
          const expired = result.error.code === 'SNAPSHOT_EXPIRED'
          if (expired) await recheckPublication(scanId)
          fail(result.error, expired)
        } else if (result.value.scanId !== scanId) {
          fail({ expectedScanId: scanId, receivedScanId: result.value.scanId })
        } else {
          setState({ status: 'ready', data: result.value })
        }
      } catch (error) {
        fail(error)
      } finally {
        pending = false
      }
    }

    retry.current = load
    // A Strict Mode mount that is already discarded does not need a storage read.
    queueMicrotask(() => void load())
    return () => {
      active = false
      retry.current = null
    }
  }, [scanId, recheckPublication])

  return { state, retry: () => void retry.current?.() }
}

export function InsightsCategoriesSection({
  scanId,
  recheckPublication,
  pageTitle
}: {
  scanId: string
  recheckPublication: (scanId: string) => Promise<void>
  pageTitle: RefObject<HTMLHeadingElement | null>
}): React.JSX.Element {
  const { state, retry } = useInsightsCategories(scanId, recheckPublication)
  const titleId = useId()
  const section = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)

  useLayoutEffect(() => {
    const region = section.current
    const heading = pageTitle.current
    return () => {
      if (region?.contains(document.activeElement)) heading?.focus()
    }
  }, [pageTitle])

  return (
    <Card ref={section} aria-labelledby={titleId} className="min-w-0 space-y-5">
      <header className="space-y-1">
        <h3 id={titleId} ref={title} tabIndex={-1} className="text-base font-semibold">
          File categories
        </h3>
        <p className="text-sm text-text-secondary">
          Share of known logical file sizes by category.
        </p>
      </header>
      {state.status === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <LoaderCircle
            size={16}
            className="shrink-0 text-accent motion-safe:animate-spin"
            aria-hidden="true"
          />
          Loading file categories…
        </p>
      )}
      {state.status === 'error' && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-error">
            {state.expired
              ? 'The saved scan may have changed. Try loading its categories again.'
              : 'SpaceLens couldn’t load file categories. Try again.'}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              title.current?.focus()
              retry()
            }}
          >
            Retry categories
          </Button>
        </div>
      )}
      {state.status === 'ready' && <CategoryDonut data={state.data} />}
    </Card>
  )
}
