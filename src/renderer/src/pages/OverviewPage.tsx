import { FolderSearch } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { StorageDevices } from '../features/overview/StorageDevices'
import type { StorageDeviceCache } from '../features/overview/useStorageDevices'
import { RecentScans } from '../features/overview/RecentScans'
import { useRecentScans } from '../features/overview/useRecentScans'
import { ScanPanel } from '../features/scanner/ScanPanel'
import { useScanner } from '../features/scanner/useScanner'
import type { SnapshotSelections } from '../features/snapshots/selection'
import type { SnapshotView } from '../../../shared/snapshotSelection'

export function OverviewPage({
  onOpenExplorer,
  onOpenSnapshot,
  snapshots,
  driveCache
}: {
  onOpenExplorer?: () => void
  onOpenSnapshot?: (view: SnapshotView, scanId: string) => void
  snapshots?: SnapshotSelections
  driveCache?: StorageDeviceCache
}): React.JSX.Element {
  const recent = useRecentScans()
  const scanner = useScanner(snapshots, recent.observeRevision)
  const scan = scanner.scan?.session
  const completedScanId = scanner.ready
    ? scan?.status === 'completed'
      ? scan.id
      : null
    : undefined
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
              !scanner.ready ||
              scanner.publicationStatus !== 'ready' ||
              !!scanner.pending ||
              scanner.scan?.session.status === 'running'
            }
          >
            <FolderSearch size={16} aria-hidden="true" />
            Scan Folder
          </Button>
        </div>
      </header>

      <ScanPanel scanner={scanner} onOpenExplorer={onOpenExplorer} />

      <StorageDevices completedScanId={completedScanId} cache={driveCache} />

      <RecentScans state={recent.state} onRetry={recent.retry} onOpenSnapshot={onOpenSnapshot} />
    </div>
  )
}
