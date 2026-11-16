import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../../lib/storage'
import type { TreemapData } from './treemapData'
import { calculateTreemap } from './treemapLayout'

/** Static rendering only. Entry identities are retained for future shared selection. */
export function Treemap({ data }: { data: TreemapData }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 640, height: 320 })
  const id = useId()
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      if (width <= 0 || height <= 0) return
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }))
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const rectangles = useMemo(() => calculateTreemap(data, size.width, size.height), [data, size])
  return (
    <figure className="min-w-0 space-y-3">
      <div
        ref={container}
        className="h-64 w-full min-w-0 overflow-hidden rounded-lg bg-background/40 sm:h-80"
      >
        <svg
          role="img"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="block h-full w-full"
        >
          <title id={`${id}-title`}>
            Storage distribution in {data.directory.name || data.directory.path}
          </title>
          <desc id={`${id}-description`}>
            Rectangle area represents known logical storage size of direct children. Files use
            logical sizes; directories use aggregated sizes. {formatBytes(data.totalBytes)} across{' '}
            {rectangles.length} positive-size entries. Unknown sizes and zero-byte entries have no
            area. This visualization is static.
          </desc>
          {rectangles.map(({ item, x, y, width, height }, index) => {
            const clip = `${id}-clip-${index}`
            return (
              <g key={item.entry.id} data-entry-id={item.entry.id}>
                <rect
                  x={x}
                  y={y}
                  width={width}
                  height={height}
                  fill={item.entry.type === 'directory' ? '#28515a' : '#34436b'}
                />
                {width >= 80 && height >= 58 && (
                  <>
                    <defs>
                      <clipPath id={clip}>
                        <rect x={x + 6} y={y + 4} width={width - 12} height={height - 8} />
                      </clipPath>
                    </defs>
                    <text
                      x={x + 8}
                      y={y + 20}
                      clipPath={`url(#${clip})`}
                      className="fill-text-primary text-xs"
                      aria-hidden="true"
                    >
                      <tspan>{item.entry.name}</tspan>
                      <tspan x={x + 8} dy={18}>
                        {item.entry.type} · {formatBytes(item.bytes!)}
                      </tspan>
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <figcaption className="text-xs text-text-secondary">
        Known sizes: {formatBytes(data.totalBytes)}. Files use logical sizes; directories use
        aggregated sizes.
        {data.unknownCount > 0 &&
          ` Sizes unavailable or invalid for ${data.unknownCount} entries; excluded from the distribution.`}
        {data.zeroCount > 0 && ` ${data.zeroCount} zero-byte entries have no area.`}
      </figcaption>
      <ul className="sr-only" aria-label="Treemap entry sizes">
        {data.children.map(({ entry, bytes }) => (
          <li key={entry.id}>
            {entry.name}, {entry.type}: {bytes === null ? 'Size unavailable' : formatBytes(bytes)}
          </li>
        ))}
      </ul>
    </figure>
  )
}
