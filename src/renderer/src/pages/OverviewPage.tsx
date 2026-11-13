import { FolderSearch } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { DiskCard } from '../features/overview/DiskCard'
import { demoDevices } from '../features/overview/demoDevices'
import { RecentScans } from '../features/overview/RecentScans'
import { ScanPanel } from '../features/scanner/ScanPanel'
import { useScanner } from '../features/scanner/useScanner'

export function OverviewPage(): React.JSX.Element {
  const scanner = useScanner()
  return (
    <div className="space-y-8 sm:space-y-10">
      <header className="flex flex-wrap items-center justify-between gap-5">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Storage Overview</h2>
          <p className="text-sm text-text-secondary">Monitor and explore your storage</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={scanner.select}
            disabled={
              !scanner.ready || !!scanner.pending || scanner.scan?.session.status === 'running'
            }
          >
            <FolderSearch size={16} aria-hidden="true" />
            Scan Folder
          </Button>
        </div>
      </header>

      <ScanPanel scanner={scanner} />

      <section aria-labelledby="storage-devices-title" className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 id="storage-devices-title" className="text-base font-semibold">
            Storage Devices
          </h3>
          <Badge>Demo data</Badge>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4">
          {demoDevices.map((device) => (
            <DiskCard key={device.id} device={device} />
          ))}
        </div>
      </section>

      <RecentScans
        scans={scanner.latestCompleted ? [scanner.latestCompleted] : []}
        unavailableScanId={scanner.snapshotUnavailable?.scanId}
      />
    </div>
  )
}
