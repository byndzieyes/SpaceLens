import { type RefObject } from 'react'
import { ChartColumn, FolderTree, GitCompareArrows, Trash2 } from 'lucide-react'
import type { ScanHistoryItem } from '../../../../shared/history'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
import { RowActionsMenu } from '../../components/ui/RowActionsMenu'
import { formatPreciseScanDate } from '../../lib/scanDisplay'

export function SnapshotActions({
  scan,
  onOpen,
  onCompare,
  onDelete,
  fallbackFocus
}: {
  scan: ScanHistoryItem
  onOpen: (view: SnapshotView, scan: ScanHistoryItem) => void
  onCompare: (scan: ScanHistoryItem) => void
  onDelete: (scan: ScanHistoryItem) => void
  fallbackFocus: RefObject<HTMLElement | null>
}): React.JSX.Element {
  return (
    <RowActionsMenu
      label={`Actions for ${scan.rootPath} completed ${formatPreciseScanDate(scan.finishedAt)}`}
      menuLabel="Snapshot actions"
      fallbackFocus={fallbackFocus}
      items={[
        {
          label: 'Open in Explorer',
          icon: <FolderTree size={16} aria-hidden="true" />,
          onSelect: () => onOpen('explorer', scan)
        },
        {
          label: 'Open in Insights',
          icon: <ChartColumn size={16} aria-hidden="true" />,
          onSelect: () => onOpen('insights', scan)
        },
        {
          label: 'Compare snapshot',
          icon: <GitCompareArrows size={16} aria-hidden="true" />,
          onSelect: () => onCompare(scan)
        },
        {
          label: 'Delete snapshot',
          icon: <Trash2 size={16} aria-hidden="true" />,
          destructive: true,
          onSelect: () => onDelete(scan)
        }
      ]}
    />
  )
}
