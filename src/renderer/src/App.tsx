import { useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/ipc'

function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    window.spaceLens.getAppInfo().then(
      (info) => {
        if (active) setAppInfo(info)
      },
      () => {
        if (active) setError('Unable to load application information.')
      }
    )

    return () => {
      active = false
    }
  }, [])

  return (
    <main>
      <h1>SpaceLens</h1>
      <p>Electron, React and TypeScript are ready.</p>
      {error ? (
        <p role="alert">{error}</p>
      ) : appInfo ? (
        <dl>
          <dt>Application</dt>
          <dd>{appInfo.name}</dd>
          <dt>Version</dt>
          <dd>{appInfo.version}</dd>
          <dt>Platform</dt>
          <dd>{appInfo.platform}</dd>
        </dl>
      ) : (
        <p>Loading application information…</p>
      )}
    </main>
  )
}

export default App
