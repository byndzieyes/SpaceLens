import { formatBytes } from '../../lib/storage'
import { comparisonCounts, comparisonSign } from './changeDisplay'

export function ComparisonBytes({
  value,
  signed = false,
  unknown = 'Unavailable'
}: {
  value: number | null
  signed?: boolean
  unknown?: string
}): React.JSX.Element {
  if (value === null) return <span className="text-text-secondary">{unknown}</span>
  const prefix = signed ? comparisonSign(value) : ''
  const magnitude = Math.abs(value)
  return (
    <span title={`${prefix}${comparisonCounts.format(magnitude)} bytes`}>
      {prefix}
      {formatBytes(magnitude)}
    </span>
  )
}
