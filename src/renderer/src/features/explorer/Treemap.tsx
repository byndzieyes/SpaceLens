import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ScanTreemapOther } from '../../../../shared/snapshot'
import { formatBytes } from '../../lib/storage'
import { treemapItemKey, type TreemapData } from './treemapData'
import { calculateTreemap } from './treemapLayout'

interface Props {
  data: TreemapData
  selectedEntryId: string | null
  onSelect: (id: string) => void
  onNavigate: (id: string) => Promise<void>
  disabled?: boolean
}

export function OtherSummary({ other }: { other: ScanTreemapOther }): React.JSX.Element {
  return (
    <p>
      Other groups {other.count.toLocaleString('en-US')} {other.count === 1 ? 'entry' : 'entries'}{' '}
      with {formatBytes(other.knownBytes)} in known sizes.
      {other.unknownCount > 0 &&
        ` Sizes unavailable for ${other.unknownCount.toLocaleString('en-US')}.`}{' '}
      Browse grouped entries in Directory Contents.
    </p>
  )
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
  const hoveredTile = rectangles.find(({ item }) => treemapItemKey(item) === hoveredId)
  const focusedTile = rectangles.find(({ item }) => treemapItemKey(item) === focusedId)
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
            const entry = item.kind === 'entry' ? item.entry : null
            return (
              <g key={treemapItemKey(item)} data-entry-id={entry?.id}>
                <rect
                  x={x}
                  y={y}
                  width={width}
                  height={height}
                  fill={entry ? (entry.type === 'directory' ? '#28515a' : '#34436b') : '#475569'}
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
                      <tspan>{entry?.name ?? 'Other'}</tspan>
                      <tspan x={x + 8} dy={18}>
                        {entry ? entry.type : 'Grouped entries'} · {formattedSize}
                      </tspan>
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>
        {/* Tile focus targets share the SVG viewBox's bounds. Only real entries are buttons. */}
        {rectangles.map(({ item, x, y, width, height, formattedSize }) => {
          const tileKey = treemapItemKey(item)
          const tile = {
            style: {
              left: `${(x / size.width) * 100}%`,
              top: `${(y / size.height) * 100}%`,
              width: `${(width / size.width) * 100}%`,
              height: `${(height / size.height) * 100}%`
            },
            onPointerEnter: () => setHoveredId(tileKey),
            onPointerLeave: () => setHoveredId(null),
            onFocus: () => {
              setHoveredId((current) => (current === tileKey ? current : null))
              setFocusedId(tileKey)
            },
            onBlur: () => setFocusedId(null)
          }
          const focusStyle =
            'absolute focus-visible:-outline-offset-4 focus-visible:outline-dotted focus-visible:outline-text-primary'
          const hoverStyle =
            tileKey === hoveredId
              ? 'after:pointer-events-none after:absolute after:inset-0.5 after:border after:border-dashed after:border-text-primary'
              : ''
          if (item.kind === 'other') {
            const { count, unknownCount } = item.aggregate
            return (
              <div
                key={tileKey}
                {...tile}
                role="img"
                tabIndex={0}
                aria-label={`Other, summary of ${count} grouped entries, ${formattedSize} in known sizes${unknownCount ? `, ${unknownCount} sizes unavailable` : ''}. Browse grouped entries in Directory Contents.`}
                className={`${focusStyle} ${hoverStyle}`}
              />
            )
          }
          const { id: entryId, name, type } = item.entry
          const selected = entryId === selectedEntryId
          return (
            <button
              key={tileKey}
              {...tile}
              type="button"
              data-entry-id={entryId}
              aria-label={`${name}, ${type}, ${formattedSize}`}
              aria-pressed={selected}
              aria-disabled={disabled || undefined}
              className={`${focusStyle} ${hoverStyle} cursor-pointer p-0 aria-disabled:cursor-default ${selected ? 'inset-ring-2 inset-ring-accent-hover' : ''}`}
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
        className="h-20 min-w-0 overflow-y-auto rounded-md bg-surface-elevated px-3 py-2 text-xs [overflow-wrap:anywhere]"
      >
        {context?.item.kind === 'other' ? (
          <>
            <p className="font-medium">Other · Grouped entries</p>
            <OtherSummary other={context.item.aggregate} />
          </>
        ) : context?.item.kind === 'entry' ? (
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
        {data.other && <OtherSummary other={data.other.aggregate} />}
        <span className="mt-1 block">
          Click or press Space to select. Double-click or press Enter to open a directory.
        </span>
      </figcaption>
    </figure>
  )
}
