export interface DonutSegment<Key extends string> {
  readonly key: Key
  readonly color: string
  readonly share: number
  readonly offset: number
}

export function DonutRing<Key extends string>({
  segments,
  active,
  onHover
}: {
  segments: readonly DonutSegment<Key>[]
  active?: Key
  onHover?: (key: Key | null) => void
}): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 200 200" className="block h-full w-full">
      <circle cx="100" cy="100" r="76" fill="none" strokeWidth="22" className="stroke-separator" />
      <g transform="rotate(-90 100 100)">
        {segments
          .filter(({ share }) => share > 0)
          .map(({ key, color, offset, share }) => (
            <circle
              key={key}
              cx="100"
              cy="100"
              r="76"
              fill="none"
              stroke={color}
              strokeWidth={active === key ? 26 : 22}
              pathLength="1"
              strokeDasharray={share === 1 ? undefined : `${share} ${1 - share}`}
              strokeDashoffset={-offset}
              opacity={active && active !== key ? 0.55 : 1}
              data-category={key}
              onPointerEnter={onHover && (() => onHover(key))}
              onPointerLeave={onHover && (() => onHover(null))}
            />
          ))}
      </g>
    </svg>
  )
}
