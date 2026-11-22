import { ChevronDown, File, Folder } from 'lucide-react'
import {
  DEFAULT_INSIGHTS_RANKING_PAGE_SIZE as PAGE_SIZE,
  INSIGHTS_RANKING_LIMIT,
  type InsightsRankedEntry
} from '../../../../shared/insights'
import { formatBytes } from '../../lib/storage'
import { InsightsAnalyticsSection } from './InsightsAnalyticsSection'
import { InsightsPagination } from './InsightsPagination'
import { useInsightsRead, type InsightsSectionProps } from './useInsightsRead'

const rankings = {
  file: {
    title: 'Largest files',
    description: `Top ${INSIGHTS_RANKING_LIMIT} regular files by logical size across the scan.`,
    noun: 'files',
    empty: 'No files to rank in this scan.',
    read: (scanId: string, offset: number) =>
      window.spaceLens.listInsightsLargestFiles({ scanId, offset, limit: PAGE_SIZE })
  },
  directory: {
    title: 'Largest directories',
    description: `Top ${INSIGHTS_RANKING_LIMIT} non-root directories by logical size of their subtrees. Parent and child totals can overlap.`,
    noun: 'directories',
    empty: 'No non-root directories to rank in this scan.',
    read: (scanId: string, offset: number) =>
      window.spaceLens.listInsightsLargestDirectories({ scanId, offset, limit: PAGE_SIZE })
  }
} as const

function RankedEntryRow({
  entry,
  rank
}: {
  entry: InsightsRankedEntry
  rank: number
}): React.JSX.Element {
  const Icon = entry.type === 'file' ? File : Folder

  return (
    <li className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-2 py-3 text-sm">
      <span className="text-text-secondary tabular-nums">#{rank}</span>
      <div className="min-w-0 space-y-1">
        <p className="flex min-w-0 items-start gap-2 font-medium">
          <Icon size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <bdi className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.name}</bdi>
        </p>
        <details className="group min-w-0 text-xs text-text-secondary">
          <summary className="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm [&::-webkit-details-marker]:hidden">
            <bdi className="min-w-0 truncate group-open:hidden" title={entry.path}>
              {entry.path}
            </bdi>
            <span className="hidden group-open:inline">Hide full path</span>
            <ChevronDown size={13} className="shrink-0 group-open:rotate-180" aria-hidden="true" />
          </summary>
          <p className="mt-2 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">
            <bdi>{entry.path}</bdi>
          </p>
        </details>
      </div>
      <span className="max-w-24 text-right font-medium tabular-nums [overflow-wrap:anywhere]">
        {entry.bytes === null ? 'Unknown size' : formatBytes(entry.bytes)}
      </span>
    </li>
  )
}

function LargestEntriesSection({
  kind,
  ...props
}: InsightsSectionProps & { kind: keyof typeof rankings }): React.JSX.Element {
  const { title, description, noun, empty, read } = rankings[kind]
  const { state, load, retry } = useInsightsRead(props, read, 0)
  const page = state.status === 'ready' ? state.data : null
  const nextOffset = page?.nextOffset ?? null

  return (
    <InsightsAnalyticsSection
      title={title}
      description={description}
      pageTitle={props.pageTitle}
      state={state}
      retry={retry}
      retryLabel={`Retry largest ${noun}`}
      controls={
        <InsightsPagination
          label={`${title} pagination`}
          previousLabel={`Previous ${kind} ranking page`}
          nextLabel={`Next ${kind} ranking page`}
          range={
            page?.entries.length
              ? `${page.offset + 1}–${page.offset + page.entries.length} of ${page.totalCount} ranked ${noun}`
              : null
          }
          previous={
            page && page.offset > 0 ? () => load(Math.max(0, page.offset - PAGE_SIZE)) : null
          }
          next={nextOffset === null ? null : () => load(nextOffset)}
        />
      }
    >
      {page?.entries.length ? (
        <ol
          aria-label={`${title} results`}
          role="list"
          start={page.offset + 1}
          className="divide-y divide-separator"
        >
          {page.entries.map((entry, index) => (
            <RankedEntryRow
              key={`${entry.scanId}:${entry.id}`}
              entry={entry}
              rank={page.offset + index + 1}
            />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-text-secondary">{empty}</p>
      )}
    </InsightsAnalyticsSection>
  )
}

export function InsightsLargestFilesSection(props: InsightsSectionProps): React.JSX.Element {
  return <LargestEntriesSection {...props} kind="file" />
}

export function InsightsLargestDirectoriesSection(props: InsightsSectionProps): React.JSX.Element {
  return <LargestEntriesSection {...props} kind="directory" />
}
