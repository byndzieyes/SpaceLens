import { CircleAlert, Files, Folder, HardDrive } from 'lucide-react'
import type { ScanSummary } from '../../../../shared/scan'
import { Card } from '../../components/ui/Card'
import { formatBytes } from '../../lib/storage'

const counts = new Intl.NumberFormat('en-US')

export function InsightsSummaryCards({ summary }: { summary: ScanSummary }): React.JSX.Element {
  const metrics = [
    { label: 'Known Logical Size', value: formatBytes(summary.totalBytes), Icon: HardDrive },
    { label: 'Files', value: counts.format(summary.fileCount), Icon: Files },
    { label: 'Directories', value: counts.format(summary.directoryCount), Icon: Folder },
    { label: 'Scan Errors', value: counts.format(summary.errorCount), Icon: CircleAlert }
  ]

  return (
    <section
      aria-label="Scan summary"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      {metrics.map(({ label, value, Icon }) => (
        <Card key={label} className="min-w-0">
          <dl className="space-y-3">
            <dt className="flex items-center gap-2 text-sm font-medium text-text-secondary">
              <Icon size={16} className="shrink-0 text-accent" aria-hidden="true" />
              {label}
            </dt>
            <dd className="text-xl font-semibold tabular-nums [overflow-wrap:anywhere]">{value}</dd>
          </dl>
        </Card>
      ))}
    </section>
  )
}
