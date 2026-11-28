import { useId } from 'react'
import { HardDrive } from 'lucide-react'
import type { StorageDevice } from '../../../../shared/storage'
import { Card } from '../../components/ui/Card'
import { formatBytes } from '../../lib/storage'

interface DiskCardProps {
  device: StorageDevice
}

export function DiskCard({ device }: DiskCardProps): React.JSX.Element {
  const titleId = useId()
  const kind = device.type === 'fixed' ? 'Fixed drive' : 'Removable drive'
  const title = device.volumeLabel ? `${device.volumeLabel} (${device.id})` : device.id
  const { capacity } = device

  return (
    <Card aria-labelledby={titleId} className="min-w-0">
      <div className="flex items-center gap-3">
        <div className="shrink-0 rounded-lg border border-accent/15 bg-accent/10 p-2.5">
          <HardDrive size={20} className="text-accent" aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-1">
          <h4 id={titleId} className="text-base font-semibold wrap-anywhere">
            {title}
          </h4>
          <p className="text-xs text-text-secondary">
            {device.rootPath} · {kind}
          </p>
        </div>
      </div>

      {capacity ? (
        <DiskCapacity capacity={capacity} title={title} />
      ) : (
        <p className="mt-5 text-sm text-text-secondary">Capacity unavailable.</p>
      )}
    </Card>
  )
}

function DiskCapacity({
  capacity,
  title
}: {
  capacity: NonNullable<StorageDevice['capacity']>
  title: string
}): React.JSX.Element {
  const { usedPercentage } = capacity
  const total = formatBytes(BigInt(capacity.totalBytes))
  const used = formatBytes(BigInt(capacity.usedBytes))
  const free = formatBytes(BigInt(capacity.freeBytes))

  return (
    <>
      <p className="mt-3 text-xs text-text-secondary">
        <span className="tabular-nums">{total}</span> total capacity
      </p>
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
          aria-valuetext={`${usedPercentage}% used (${used} of ${total}); ${free} free`}
          className="h-2 overflow-hidden rounded-full bg-surface-active"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${usedPercentage}%` }} />
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4">
        <div className="min-w-0 space-y-1">
          <dt className="text-xs text-text-secondary">Used</dt>
          <dd className="text-lg font-semibold wrap-anywhere tabular-nums">{used}</dd>
        </div>
        <div className="min-w-0 space-y-1 text-right">
          <dt className="text-xs text-text-secondary">Free</dt>
          <dd className="text-lg font-semibold wrap-anywhere text-success tabular-nums">{free}</dd>
        </div>
      </dl>
    </>
  )
}
