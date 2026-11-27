import { useEffect, useId, useState } from 'react'
import type {
  InsightsCategories,
  InsightsCategoryRow,
  InsightsFileCategory
} from '../../../../shared/insights'
import { formatBytes } from '../../lib/storage'
import { DonutRing } from '../../components/ui/DonutRing'
import { categoryLabels } from './insightsDisplay'

const categoryColors: Record<InsightsFileCategory, string> = {
  images: '#a5b4fc',
  videos: '#38bdf8',
  audio: '#5eead4',
  documents: '#fcd34d',
  archives: '#fb923c',
  code: '#c084fc',
  applications: '#f9a8d4',
  other: '#94a3b8'
}

const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })
const counts = new Intl.NumberFormat('en-US')

interface ChartCategory extends InsightsCategoryRow {
  label: string
  color: string
  share: number
  offset: number
}

function formatShare(share: number): string {
  if (share > 0 && share < 0.001) return '<0.1%'
  if (share > 0.999 && share < 1) return '>99.9%'
  return percent.format(share)
}

export function CategoryDonut({ data }: { data: InsightsCategories }): React.JSX.Element {
  const tooltipId = useId()
  const [hovered, setHovered] = useState<InsightsFileCategory | null>(null)
  const [focused, setFocused] = useState<InsightsFileCategory | null>(null)
  const knownBytes = data.categories.reduce((sum, row) => sum + row.knownBytes, 0)
  let precedingBytes = 0
  const rows: ChartCategory[] = []
  for (const row of data.categories) {
    rows.push({
      ...row,
      label: categoryLabels[row.category],
      color: categoryColors[row.category],
      share: knownBytes ? row.knownBytes / knownBytes : 0,
      offset: knownBytes ? precedingBytes / knownBytes : 0
    })
    precedingBytes += row.knownBytes
  }
  const active = rows.find((row) => row.category === (hovered ?? focused))
  const tooltipVisible = active !== undefined

  useEffect(() => {
    if (!tooltipVisible) return

    function dismissTooltip(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setHovered(null)
        setFocused(null)
      }
    }

    document.addEventListener('keydown', dismissTooltip)
    return () => document.removeEventListener('keydown', dismissTooltip)
  }, [tooltipVisible])

  return (
    <figure
      aria-label="Known logical bytes by file category"
      className="grid min-w-0 items-center gap-6 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]"
    >
      {knownBytes > 0 ? (
        <div className="relative mx-auto grid aspect-square w-full max-w-52 place-items-center">
          <DonutRing
            segments={rows.map((row) => ({ ...row, key: row.category }))}
            active={active?.category}
            onHover={setHovered}
          />
          {active ? (
            <div
              id={tooltipId}
              role="tooltip"
              className="pointer-events-none absolute max-w-[66%] rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-center text-xs [overflow-wrap:anywhere]"
            >
              <p className="font-semibold">{active.label}</p>
              <p className="text-text-secondary">{formatBytes(active.knownBytes)}</p>
              <p className="text-text-secondary">{formatShare(active.share)}</p>
            </div>
          ) : (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute max-w-[62%] text-center [overflow-wrap:anywhere]"
            >
              <p className="text-xs text-text-secondary">Known logical size</p>
              <p className="text-base font-semibold tabular-nums">{formatBytes(knownBytes)}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-text-secondary md:col-span-2">No known bytes to chart.</p>
      )}

      {rows.length > 0 && (
        <ul
          aria-label="Category values"
          role="list"
          className={`min-w-0 divide-y divide-separator ${knownBytes === 0 ? 'md:col-span-2' : ''}`}
        >
          {rows.map(
            ({ category, label, color, knownBytes: bytes, fileCount, unknownSizeCount, share }) => (
              <li
                key={category}
                tabIndex={share > 0 ? 0 : undefined}
                aria-describedby={active?.category === category ? tooltipId : undefined}
                className={`grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-start gap-3 rounded-sm px-2 py-2 focus-visible:-outline-offset-2 [overflow-wrap:anywhere] ${active?.category === category ? 'bg-surface-hover' : ''}`}
                onPointerEnter={() => setHovered(share > 0 ? category : null)}
                onPointerLeave={() => setHovered(null)}
                onFocus={() => {
                  setHovered(null)
                  setFocused(category)
                }}
                onBlur={() => setFocused(null)}
              >
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2 text-sm font-medium">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="min-w-0">{label}</span>
                  </p>
                  <p className="pl-4.5 text-xs text-text-secondary">
                    {counts.format(fileCount)} {fileCount === 1 ? 'file' : 'files'}
                    {unknownSizeCount > 0 &&
                      ` · ${counts.format(unknownSizeCount)} ${unknownSizeCount === 1 ? 'size' : 'sizes'} unknown`}
                  </p>
                </div>
                <div className="min-w-0 text-right tabular-nums">
                  <p className="text-sm font-medium">{formatBytes(bytes)}</p>
                  {knownBytes > 0 && (
                    <p className="text-xs text-text-secondary">{formatShare(share)}</p>
                  )}
                </div>
              </li>
            )
          )}
        </ul>
      )}
    </figure>
  )
}
