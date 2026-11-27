import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './Button'

export function Pagination({
  label,
  previousLabel,
  nextLabel,
  range,
  previous,
  next,
  className = ''
}: {
  label: string
  previousLabel: string
  nextLabel: string
  range: string | null
  previous: (() => void) | null
  next: (() => void) | null
  className?: string
}): React.JSX.Element {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${className}`}>
      <p aria-live="polite" className="min-w-0 text-sm text-text-secondary tabular-nums">
        {range}
      </p>
      <div role="group" aria-label={label} className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          aria-label={previousLabel}
          aria-disabled={!previous}
          tabIndex={previous ? undefined : -1}
          className="aria-disabled:opacity-50"
          onClick={() => previous?.()}
        >
          <ChevronLeft size={14} aria-hidden="true" /> Previous
        </Button>
        <Button
          variant="secondary"
          aria-label={nextLabel}
          aria-disabled={!next}
          tabIndex={next ? undefined : -1}
          className="aria-disabled:opacity-50"
          onClick={() => next?.()}
        >
          Next <ChevronRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
