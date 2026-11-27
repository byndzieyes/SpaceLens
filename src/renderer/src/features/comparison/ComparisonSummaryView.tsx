import { useId, type ReactNode } from 'react'
import type {
  ComparisonFileSummary,
  ComparisonSummary,
  EntryChangeKind
} from '../../../../shared/comparison'
import { Card } from '../../components/ui/Card'
import { DonutRing, type DonutSegment } from '../../components/ui/DonutRing'
import { ComparisonBytes as Bytes } from './ComparisonBytes'
import { comparisonCounts as counts, comparisonSign as sign, fileKinds } from './changeDisplay'

const ringKinds = ['added', 'removed', 'modified', 'indeterminate'] as const
const kinds = [...ringKinds, 'unchanged'] as const
const signedCount = (value: number): string => sign(value) + counts.format(Math.abs(value))

function percentage(delta: number, baseline: number): string | undefined {
  if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(baseline) || baseline < 0)
    return undefined
  if (delta === 0) return '0%'
  if (baseline <= 0) return undefined

  // Round to tenths of a percent without converting a potentially unsafe scaled integer.
  const denominator = BigInt(baseline)
  const tenths = (2000n * BigInt(Math.abs(delta)) + denominator) / (2n * denominator)
  if (tenths === 0n) return '<0.1%'
  const fraction = tenths % 10n
  return `${sign(delta)}${counts.format(tenths / 10n)}${fraction ? `.${fraction}` : ''}%`
}

function ObservedMetric({
  title,
  baseline,
  target,
  delta,
  change
}: {
  title: string
  baseline: ReactNode
  target: ReactNode
  delta: ReactNode
  change?: string
}): React.JSX.Element {
  const titleId = useId()
  return (
    <Card aria-labelledby={titleId} className="min-w-0 space-y-3 p-4! [overflow-wrap:anywhere]">
      <h4
        id={titleId}
        className="text-sm font-medium text-text-secondary @min-[38rem]:min-h-10 @min-[54rem]:min-h-0"
      >
        {title}
      </h4>
      <dl className="grid min-w-0 grid-cols-2 gap-2 tabular-nums">
        <div className="col-span-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-separator pb-2">
          <dt className="sr-only">Observed delta</dt>
          <dd className="text-xl font-semibold">{delta}</dd>
          {change && <dd className="text-xs text-text-secondary">{change}</dd>}
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Baseline</dt>
          <dd className="text-sm font-medium">{baseline}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Target</dt>
          <dd className="text-sm font-medium">{target}</dd>
        </div>
      </dl>
    </Card>
  )
}

function FileDistribution({ files }: { files: ComparisonFileSummary }): React.JSX.Element {
  const titleId = useId()
  const charted = files.totalCount - files.counts.unchanged
  const segments: DonutSegment<EntryChangeKind>[] = []
  let preceding = 0
  for (const key of ringKinds) {
    const count = files.counts[key]
    segments.push({
      key,
      color: fileKinds[key].color,
      share: charted ? count / charted : 0,
      offset: charted ? preceding / charted : 0
    })
    preceding += count
  }
  return (
    <Card aria-labelledby={titleId} className="@container min-w-0 space-y-3">
      <h4 id={titleId} className="text-base font-semibold">
        File change distribution
      </h4>
      <figure
        aria-label="Non-unchanged file records with exact counts by classification"
        className="grid min-w-0 items-center gap-x-4 gap-y-3 @min-[26rem]:grid-cols-[8rem_minmax(0,1fr)]"
      >
        {charted > 0 ? (
          <div className="relative mx-auto grid aspect-square w-32 max-w-full place-items-center">
            <DonutRing segments={segments} />
            <p className="pointer-events-none absolute max-w-[56%] text-center text-xs leading-tight text-text-secondary [overflow-wrap:anywhere]">
              <strong className="block text-sm text-text-primary tabular-nums">
                {counts.format(charted)}
              </strong>
              Non-unchanged
            </p>
          </div>
        ) : (
          <p className="text-sm text-text-secondary @min-[26rem]:col-span-2">
            {files.totalCount
              ? 'All file records are unchanged by available metadata.'
              : 'No file records in either snapshot.'}
          </p>
        )}
        <dl
          className={`min-w-0 divide-y divide-separator text-sm ${charted ? '' : '@min-[26rem]:col-span-2'}`}
        >
          {kinds.map((kind) => (
            <div
              key={kind}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-baseline gap-2 py-1.5 [overflow-wrap:anywhere]"
            >
              <dt className="flex min-w-0 items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: fileKinds[kind].color }}
                />
                <span className="min-w-0">{fileKinds[kind].label}</span>
              </dt>
              <dd className="text-right font-medium tabular-nums">
                {counts.format(files.counts[kind])}
              </dd>
            </div>
          ))}
        </dl>
      </figure>
      {charted > 0 && (
        <p className="text-xs text-text-secondary">
          The ring covers non-unchanged records, including indeterminate ones. Unchanged is based on
          available size and timestamp metadata.
        </p>
      )}
    </Card>
  )
}

function ByteAccounting({ files }: { files: ComparisonFileSummary }): React.JSX.Element {
  const titleId = useId()
  const known = files.knownDeltaCount > 0 || files.unknownDeltaCount === 0
  const confirmedChanges = files.totalCount - files.counts.unchanged - files.counts.indeterminate
  const confirmedKnown =
    confirmedChanges === 0 || files.confirmedUnknownDeltaCount < confirmedChanges
  const maximum = Math.max(files.positiveDeltaBytes, Math.abs(files.negativeDeltaBytes))
  const bars = [
    { label: 'Known file growth', value: files.positiveDeltaBytes, color: 'bg-[#a5b4fc]' },
    { label: 'Known file reduction', value: files.negativeDeltaBytes, color: 'bg-[#8bc9d5]' }
  ]
  const row = 'grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2'
  return (
    <Card aria-labelledby={titleId} className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <h4 id={titleId} className="text-base font-semibold">
        File byte accounting
      </h4>
      <figure aria-label="Known file growth and reduction on a shared magnitude scale">
        <ul className="space-y-3 text-sm tabular-nums">
          {bars.map(({ label, value, color }) => (
            <li key={label} className="space-y-1">
              <p className={row}>
                <span>{label}</span>
                <span className="font-medium">
                  <Bytes value={known ? value : null} signed />
                </span>
              </p>
              {known && (
                <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-separator">
                  <div
                    className={`h-full rounded-full ${color}`}
                    style={{ width: `${maximum ? (Math.abs(value) / maximum) * 100 : 0}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </figure>
      <dl className="space-y-2 border-t border-separator pt-3 text-sm tabular-nums">
        <div className={row}>
          <dt>Net known file delta</dt>
          <dd className="font-semibold">
            <Bytes value={known ? files.netKnownDeltaBytes : null} signed />
          </dd>
        </div>
        <div className={row}>
          <dt>Confirmed-only known net</dt>
          <dd className="font-medium">
            <Bytes value={confirmedKnown ? files.confirmedKnownDeltaBytes : null} signed />
          </dd>
        </div>
        <div className={`${row} text-text-secondary`}>
          <dt>Unknown byte deltas</dt>
          <dd>{counts.format(files.unknownDeltaCount)}</dd>
        </div>
        <div className={`${row} text-text-secondary`}>
          <dt>Confirmed changes with unknown bytes</dt>
          <dd>{counts.format(files.confirmedUnknownDeltaCount)}</dd>
        </div>
      </dl>
      <p className="text-xs text-text-secondary">
        The known net can include indeterminate records. Confirmed-only net excludes them.
      </p>
    </Card>
  )
}

export function ComparisonSummaryView({
  summary
}: {
  summary: ComparisonSummary
}): React.JSX.Element {
  const { baseline, target, observedSnapshotBytes: sizes, files, compatibility } = summary
  const partial =
    compatibility.coverage.baseline !== 'complete' || compatibility.coverage.target !== 'complete'
  return (
    <div className="min-w-0 space-y-3">
      <div className="grid min-w-0 gap-3 @min-[38rem]:grid-cols-3">
        <ObservedMetric
          title="Observed logical size"
          baseline={<Bytes value={sizes.baseline} />}
          target={<Bytes value={sizes.target} />}
          delta={<Bytes value={sizes.delta} signed />}
          change={percentage(sizes.delta, sizes.baseline)}
        />
        <ObservedMetric
          title="Observed file count"
          baseline={counts.format(baseline.summary.fileCount)}
          target={counts.format(target.summary.fileCount)}
          delta={signedCount(summary.fileCountDelta)}
        />
        <ObservedMetric
          title="Observed directory count"
          baseline={counts.format(baseline.summary.directoryCount)}
          target={counts.format(target.summary.directoryCount)}
          delta={signedCount(summary.directoryCountDelta)}
        />
      </div>
      <div className="grid min-w-0 gap-3 @min-[54rem]:grid-cols-2">
        <FileDistribution files={files} />
        <ByteAccounting files={files} />
      </div>
      {(partial || files.counts.indeterminate > 0 || files.unknownDeltaCount > 0) && (
        <p className="rounded-lg border border-warning/20 bg-warning/5 px-4 py-3 text-sm text-text-secondary">
          {partial &&
            'Incomplete coverage can omit entries. Observed differences may reflect gaps in the scans. '}
          {files.counts.indeterminate > 0 && 'Some file changes could not be confirmed. '}
          {files.unknownDeltaCount > 0 && 'Unknown byte deltas are excluded from known totals.'}
        </p>
      )}
    </div>
  )
}
