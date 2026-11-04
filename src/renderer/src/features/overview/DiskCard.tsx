import { useId } from 'react'
import { HardDrive } from 'lucide-react'
import type { StorageDevice } from '../../../../shared/storage'
import { Card } from '../../components/ui/Card'
import { formatStorageSize, getStorageUsage } from '../../lib/storage'

interface DiskCardProps {
  device: StorageDevice
}

export function DiskCard({ device }: DiskCardProps): React.JSX.Element {
  const titleId = useId()
  const { availableBytes, usedPercentage } = getStorageUsage(device.totalBytes, device.usedBytes)
  const total = formatStorageSize(device.totalBytes)
  const used = formatStorageSize(device.usedBytes)
  const available = formatStorageSize(availableBytes)
  const title = `${device.name} ${device.mountPoint}`

  return (
    <Card aria-labelledby={titleId} className="min-w-0">
      <div className="flex items-center gap-3">
        <div className="shrink-0 rounded-lg border border-accent/15 bg-accent/10 p-2.5">
          <HardDrive size={20} className="text-accent" aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-1">
          <h4 id={titleId} className="text-base font-semibold break-words">
            {title}
          </h4>
          <p className="text-xs text-text-secondary">
            <span className="tabular-nums">{total}</span> total capacity
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
          <span className="text-text-secondary">Space used</span>
          <span className="font-semibold text-accent tabular-nums">{usedPercentage}%</span>
        </div>
        <div
          role="progressbar"
          aria-label={`${title} storage used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usedPercentage}
          aria-valuetext={`${usedPercentage}% used (${used} of ${total}); ${available} available`}
          className="h-2 overflow-hidden rounded-full bg-surface-active"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${usedPercentage}%` }} />
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4">
        <div className="min-w-0 space-y-1">
          <dt className="text-xs text-text-secondary">Used</dt>
          <dd className="text-lg font-semibold break-words tabular-nums">{used}</dd>
        </div>
        <div className="min-w-0 space-y-1 text-right">
          <dt className="text-xs text-text-secondary">Available</dt>
          <dd className="text-lg font-semibold break-words text-success tabular-nums">
            {available}
          </dd>
        </div>
      </dl>
    </Card>
  )
}
