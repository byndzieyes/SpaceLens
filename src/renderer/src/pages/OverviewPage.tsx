import { FolderSearch, History } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { DiskCard } from '../features/overview/DiskCard'
import { demoDevices } from '../features/overview/demoDevices'

export function OverviewPage(): React.JSX.Element {
  return (
    <div className="space-y-8 sm:space-y-10">
      <header className="flex flex-wrap items-center justify-between gap-5">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Storage Overview</h2>
          <p className="text-sm text-text-secondary">Monitor and explore your storage</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span id="scan-folder-status" className="text-xs text-text-secondary">
            Coming soon
          </span>
          <Button disabled aria-describedby="scan-folder-status">
            <FolderSearch size={16} aria-hidden="true" />
            Scan Folder
          </Button>
        </div>
      </header>

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

      <section aria-labelledby="recent-scans-title" className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 id="recent-scans-title" className="text-base font-semibold">
            Recent Scans
          </h3>
          <Badge>Preview</Badge>
        </div>
        <Card aria-label="Recent scans placeholder" className="min-h-48">
          <div className="flex items-center gap-3 text-text-secondary">
            <History size={18} className="shrink-0" aria-hidden="true" />
            <p className="text-sm">Recent scan list placeholder</p>
          </div>
          <div aria-hidden="true" className="mt-6 divide-y divide-separator">
            {[1, 2].map((slot) => (
              <div key={slot} className="flex items-center justify-between gap-6 py-4">
                <div className="h-2 w-2/5 rounded-sm bg-surface-elevated" />
                <div className="h-2 w-1/5 rounded-sm bg-surface-elevated" />
              </div>
            ))}
          </div>
        </Card>
      </section>
    </div>
  )
}
