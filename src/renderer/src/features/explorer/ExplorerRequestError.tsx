import { Button } from '../../components/ui/Button'
import { isStaleSnapshotError } from './data'

export interface ExplorerRequestFailure {
  code: string
  message: string
}

export function ExplorerRequestError({
  error,
  actionLabel,
  refreshLabel,
  onRetry,
  onRefresh,
  disabled
}: {
  error: ExplorerRequestFailure
  actionLabel: string
  refreshLabel: string
  onRetry: () => void
  onRefresh?: () => void
  disabled?: boolean
}): React.JSX.Element {
  const stale = isStaleSnapshotError(error.code)
  const action = stale ? onRefresh : onRetry
  return (
    <div className="space-y-2 py-3 text-sm [overflow-wrap:anywhere]">
      <p role="alert" className="text-error">
        {error.code}: {error.message}
        {stale && ' Use Refresh snapshot to check which results are available.'}
      </p>
      {action && (
        <Button
          variant="secondary"
          aria-label={stale ? refreshLabel : undefined}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : undefined}
          className="max-w-full text-left aria-disabled:opacity-50 focus-visible:-outline-offset-2"
          onClick={() => {
            if (!disabled) action()
          }}
        >
          {stale ? 'Refresh snapshot' : actionLabel}
        </Button>
      )}
    </div>
  )
}
