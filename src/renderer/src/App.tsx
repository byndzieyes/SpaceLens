import { useEffect, useState } from 'react'
import { Check, CircleAlert, HardDrive, RefreshCw } from 'lucide-react'
import type { AppInfo } from '../../shared/ipc'
import { Badge } from './components/ui/Badge'
import { Button } from './components/ui/Button'
import { Card } from './components/ui/Card'

function App(): React.JSX.Element {
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
    <main className="flex min-h-dvh items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
      <div className="w-full max-w-xl space-y-8">
        <header className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated text-accent">
            <HardDrive size={24} strokeWidth={1.75} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight">SpaceLens</h1>
            <p className="mt-1 text-sm text-text-secondary">A clearer view of your storage.</p>
          </div>
        </header>

        <Card aria-labelledby="app-info-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="app-info-title" className="text-base font-semibold">
                Application information
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Details about this running instance.
              </p>
            </div>
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
          </div>

          <div className="my-6" aria-busy={loading}>
            {error && (
              <p
                role="alert"
                className="mb-4 rounded-md border border-error/20 bg-error/10 p-3 text-error"
              >
                {error}
              </p>
            )}
            {appInfo ? (
              <dl className="divide-y divide-separator">
                {[
                  ['Application', appInfo.name],
                  ['Version', appInfo.version],
                  ['Operating system', appInfo.platform]
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-2 sm:gap-4"
                  >
                    <dt className="text-text-secondary">{label}</dt>
                    <dd className="min-w-0 font-mono text-sm break-words sm:text-right">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : loading ? (
              <p className="text-text-secondary">Loading application information…</p>
            ) : null}
          </div>

          <div className="flex justify-end border-t border-separator pt-5">
            <Button onClick={refreshAppInfo} disabled={loading} aria-busy={loading}>
              <RefreshCw size={16} aria-hidden="true" />
              Refresh information
            </Button>
          </div>
        </Card>
      </div>
    </main>
  )
}

export default App
