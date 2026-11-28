import { RefreshCw } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { DiskCard } from './DiskCard'
import { useStorageDevices, type StorageDeviceCache } from './useStorageDevices'

export function StorageDevices({
  completedScanId,
  cache
}: {
  completedScanId: string | null | undefined
  cache?: StorageDeviceCache
}): React.JSX.Element {
  const { state, refresh } = useStorageDevices(completedScanId, cache)
  const { devices } = state

  return (
    <section aria-labelledby="storage-devices-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="storage-devices-title" className="text-base font-semibold">
          Storage Devices
        </h3>
        <Button
          variant="secondary"
          aria-label={
            state.status === 'error' ? 'Retry drive information' : 'Refresh drive information'
          }
          onClick={refresh}
          disabled={state.status === 'loading'}
          className="px-3"
        >
          <RefreshCw size={14} aria-hidden="true" />
          {state.status === 'error' ? 'Retry' : 'Refresh'}
        </Button>
      </div>
      {state.status === 'loading' && (
        <p role="status" className="text-sm text-text-secondary">
          {devices === null ? 'Loading drive information…' : 'Refreshing drive information…'}
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-sm text-error">
          {state.message}
          {devices !== null && ' Showing the last result, which may be outdated.'}
        </p>
      )}
      {devices?.length === 0 && (
        <p className="text-sm text-text-secondary">No supported drives were found.</p>
      )}
      {!!devices?.length && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4">
          {devices.map((device) => (
            <DiskCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </section>
  )
}
