import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import type { InsightsSectionProps } from './useInsightsRead'

export function InsightsAnalyticsSection({
  title,
  description,
  pageTitle,
  state,
  retry,
  retryLabel,
  controls,
  children
}: {
  title: string
  description: string
  pageTitle: InsightsSectionProps['pageTitle']
  state: { status: 'loading' | 'ready' } | { status: 'error'; expired: boolean }
  retry: () => void
  retryLabel: string
  controls?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const titleId = useId()
  const region = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const subject = title.toLowerCase()

  useLayoutEffect(() => {
    const section = region.current
    const destination = pageTitle.current
    return () => {
      if (section?.contains(document.activeElement)) destination?.focus()
    }
  }, [pageTitle])

  return (
    <Card ref={region} aria-labelledby={titleId} className="min-w-0 space-y-5">
      <header className="space-y-1">
        <h3 id={titleId} ref={heading} tabIndex={-1} className="text-base font-semibold">
          {title}
        </h3>
        <p className="text-sm text-text-secondary">{description}</p>
      </header>
      {controls}
      {state.status === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <LoaderCircle
            size={16}
            className="shrink-0 text-accent motion-safe:animate-spin"
            aria-hidden="true"
          />
          Loading {subject}…
        </p>
      )}
      {state.status === 'error' && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-error">
            {state.expired
              ? `The saved scan may have changed. Try loading ${subject} again.`
              : `SpaceLens couldn’t load ${subject}. Try again.`}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              heading.current?.focus()
              retry()
            }}
          >
            {retryLabel}
          </Button>
        </div>
      )}
      {state.status === 'ready' && children}
    </Card>
  )
}
