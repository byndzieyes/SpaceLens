import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../../lib/storage'
import type { TreemapData } from './treemapData'
import { calculateTreemap } from './treemapLayout'

interface Props {
  data: TreemapData
  selectedEntryId: string | null
  onSelect: (id: string) => void
  onNavigate: (id: string) => Promise<void>
  disabled?: boolean
}

export function Treemap({
  data,
  selectedEntryId,
  onSelect,
  onNavigate,
  disabled
}: Props): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 640, height: 320 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
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
  const rectangles = useMemo(
    () =>
      calculateTreemap(data, size.width, size.height).flatMap((rectangle) => {
        const { width, height, item } = rectangle
        if (width <= 0 || height <= 0 || item.bytes === null) return []
        return [{ ...rectangle, formattedSize: formatBytes(item.bytes) }]
      }),
    [data, size]
  )
  const hoveredTile = rectangles.find(({ item }) => item.entry.id === hoveredId)
  const focusedTile = rectangles.find(({ item }) => item.entry.id === focusedId)
  // Resizing can collapse a small tile. Clear its context so it doesn't reappear unprompted.
  if (hoveredId !== null && !hoveredTile) setHoveredId(null)
  if (focusedId !== null && !focusedTile) setFocusedId(null)
  const context = hoveredTile ?? focusedTile
  return (
    <figure
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className="min-w-0 space-y-3"
    >
      <p id={`${id}-title`} className="sr-only">
        Storage distribution in {data.directory.name || data.directory.path}
      </p>
      <div
        ref={container}
        className="relative isolate h-64 w-full min-w-0 overflow-hidden rounded-lg bg-background/40 sm:h-80"
      >
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
          className="pointer-events-none block h-full w-full"
        >
          {rectangles.map(({ item, x, y, width, height, formattedSize }, index) => {
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
                        {item.entry.type} · {formattedSize}
                      </tspan>
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>
        {/* Native buttons share the SVG viewBox's bounds and provide standard focus and semantics. */}
        {rectangles.map(({ item, x, y, width, height, formattedSize }) => {
          const { id: entryId, name, type } = item.entry
          const selected = entryId === selectedEntryId
          const hovered = entryId === hoveredId
          return (
            <button
              key={entryId}
              type="button"
              data-entry-id={entryId}
              aria-label={`${name}, ${type}, ${formattedSize}`}
              aria-pressed={selected}
              aria-disabled={disabled || undefined}
              style={{
                left: `${(x / size.width) * 100}%`,
                top: `${(y / size.height) * 100}%`,
                width: `${(width / size.width) * 100}%`,
                height: `${(height / size.height) * 100}%`
              }}
              className={`absolute cursor-pointer p-0 focus-visible:-outline-offset-4 focus-visible:outline-dotted focus-visible:outline-text-primary aria-disabled:cursor-default ${selected ? 'inset-ring-2 inset-ring-accent-hover' : ''} ${hovered ? 'after:pointer-events-none after:absolute after:inset-0.5 after:border after:border-dashed after:border-text-primary' : ''}`}
              onPointerEnter={() => setHoveredId(entryId)}
              onPointerLeave={() => setHoveredId(null)}
              onFocus={() => {
                setHoveredId((current) => (current === entryId ? current : null))
                setFocusedId(entryId)
              }}
              onBlur={() => setFocusedId(null)}
              onClick={() => {
                if (!disabled) onSelect(entryId)
              }}
              onDoubleClick={() => {
                if (!disabled && type === 'directory') void onNavigate(entryId)
              }}
              onKeyDown={(event) => {
                if (event.key !== ' ' && event.key !== 'Enter') return
                event.preventDefault()
                if (disabled || event.repeat) return
                if (event.key === 'Enter' && type === 'directory') void onNavigate(entryId)
                else onSelect(entryId)
              }}
            />
          )
        })}
      </div>
      <div
        role="group"
        aria-label="Treemap entry information"
        className="h-20 min-w-0 rounded-md bg-surface-elevated px-3 py-2 text-xs [overflow-wrap:anywhere]"
      >
        {context ? (
          <>
            <p className="line-clamp-2 font-medium">{context.item.entry.name}</p>
            <p className="mt-1 text-text-secondary">
              {context.item.entry.type}
              {' · '}
              {context.item.entry.type === 'directory' ? 'Aggregated size:' : 'Logical size:'}{' '}
              {context.formattedSize}
            </p>
          </>
        ) : (
          <p className="text-text-secondary">
            Point to or focus a tile to see its entry information.
          </p>
        )}
      </div>
      <ul className="sr-only" aria-label="Treemap entry sizes">
        {data.children.map(({ entry, bytes }) => (
          <li key={entry.id}>
            {entry.name}, {entry.type}: {bytes === null ? 'Size unavailable' : formatBytes(bytes)}
          </li>
        ))}
      </ul>
      <figcaption id={`${id}-description`} className="text-xs text-text-secondary">
        Rectangle area represents known logical storage size of direct children. Known sizes:{' '}
        {formatBytes(data.totalBytes)}. Files use logical sizes and directories use aggregated
        sizes.
        {data.unknownCount > 0 &&
          ` Sizes unavailable or invalid for ${data.unknownCount} entries; excluded from the distribution.`}
        {data.zeroCount > 0 && ` ${data.zeroCount} zero-byte entries have no area.`}
        <span className="mt-1 block">
          Click or press Space to select. Double-click or press Enter to open a directory.
        </span>
      </figcaption>
    </figure>
  )
}
