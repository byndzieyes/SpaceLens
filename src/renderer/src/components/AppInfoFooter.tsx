import { useEffect, useState } from 'react'
import { Check, CircleAlert, RefreshCw } from 'lucide-react'
import type { AppInfo } from '../../../shared/ipc'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'

export function AppInfoFooter(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
    let active = true

    window.spaceLens.getAppInfo().then(
      (info) => {
        if (active) {
          setAppInfo(info)
          setLoading(false)
        }
      },
      () => {
        if (active) {
          setError('Unable to load application information. Please try again.')
          setLoading(false)
        }
      }
    )

    return () => {
      active = false
    }
  }, [requestVersion])

  function refreshAppInfo(): void {
    setLoading(true)
    setError(null)
    setRequestVersion((version) => version + 1)
  }

  return (
    <footer
      aria-label="Application information"
      className="shrink-0 border-t border-separator bg-surface/40 px-4 py-3 sm:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span role="status">
            <Badge variant={error ? 'error' : appInfo ? 'success' : 'neutral'}>
              {error ? (
                <CircleAlert size={12} aria-hidden="true" />
              ) : appInfo ? (
                <Check size={12} aria-hidden="true" />
              ) : null}
              {error ? 'Unavailable' : appInfo ? 'Ready' : 'Loading'}
            </Badge>
          </span>
          <div aria-busy={loading}>
            {appInfo && (
              <dl className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-text-secondary">
                {[
                  ['Application', appInfo.name],
                  ['Version', appInfo.version],
                  ['Operating system', appInfo.platform]
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="sr-only">{label}</dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={refreshAppInfo}
          disabled={loading}
          aria-busy={loading}
          aria-label="Refresh application information"
          className="shrink-0"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </footer>
  )
}
