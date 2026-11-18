import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject
} from 'react'
import type { FileEntry } from '../../../../shared/scan'
import { MAX_SCAN_TREEMAP_ENTRIES } from '../../../../shared/snapshot'
import { Button } from '../../components/ui/Button'
import { createTreemapData, type TreemapData } from './treemapData'
import { Treemap, OtherSummary } from './Treemap'

type Interactions = Omit<ComponentProps<typeof Treemap>, 'data'>

type Props = Interactions & {
  scanId: string | null
  directory: FileEntry | null
}
type State =
  | { status: 'loading' }
  | { status: 'error'; code: string; message: string }
  | { status: 'ready'; data: TreemapData }

export function DirectoryTreemap({ scanId, directory, ...interactions }: Props): React.JSX.Element {
  const focusTarget = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={focusTarget}
      role="group"
      aria-label="Treemap visualization"
      tabIndex={-1}
      className="mt-4 min-h-64 min-w-0 flex-1 [overflow-wrap:anywhere]"
    >
      {scanId && directory ? (
        <TreemapRequest
          key={JSON.stringify([scanId, directory.id])}
          scanId={scanId}
          directory={directory}
          focusTarget={focusTarget}
          {...interactions}
        />
      ) : (
        <p className="py-6 text-sm text-text-secondary">
          No treemap available. An available snapshot and current directory are required.
        </p>
      )}
    </div>
  )
}

function TreemapRequest({
  scanId,
  directory,
  focusTarget,
  ...interactions
}: Interactions & {
  scanId: string
  directory: FileEntry
  focusTarget: RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useLayoutEffect(
    () => () => {
      const target = focusTarget.current
      const focused = target?.ownerDocument.activeElement
      // Keep the next Tab in this panel after a focused tile is removed.
      if (target && focused !== target && target.contains(focused ?? null))
        target.focus({ preventScroll: true })
    },
    [focusTarget]
  )
  useEffect(() => {
    let active = true
    queueMicrotask(async () => {
      if (!active) return
      try {
        const result = await window.spaceLens.getScanDirectoryTreemap({
          scanId,
          entryId: directory.id
        })
        if (!active) return
        if (!result.ok) {
          setState({ status: 'error', ...result.error })
          return
        }
        const summary = result.value
        if (
          summary.scanId !== scanId ||
          summary.directoryId !== directory.id ||
          directory.scanId !== scanId ||
          !Number.isSafeInteger(summary.totalCount) ||
          summary.totalCount < 0 ||
          summary.individualCount !== Math.min(summary.totalCount, MAX_SCAN_TREEMAP_ENTRIES) ||
          summary.individualCount !== summary.entries.length ||
          summary.individualCount + (summary.other?.count ?? 0) !== summary.totalCount
        ) {
          setState({
            status: 'error',
            code: 'INVALID_REQUEST',
            message: 'Treemap metadata does not match this snapshot request.'
          })
          return
        }
        try {
          const data = createTreemapData(directory, summary.entries, summary.other)
          if (data.unknownCount !== summary.unknownCount)
            throw new Error('Invalid unknown-size count.')
          setState({ status: 'ready', data })
        } catch (error) {
          setState({
            status: 'error',
            code: 'INVALID_REQUEST',
            message: error instanceof Error ? error.message : 'Invalid entry metadata.'
          })
        }
      } catch {
        if (active)
          setState({
            status: 'error',
            code: 'TRANSPORT_ERROR',
            message: 'Treemap data could not be loaded.'
          })
      }
    })
    return () => {
      active = false
    }
  }, [scanId, directory, attempt])

  if (state.status === 'loading')
    return (
      <p role="status" className="py-6 text-sm text-text-secondary">
        Loading treemap…
      </p>
    )
  if (state.status === 'error')
    return (
      <div className="space-y-4 py-6">
        <p role="alert" className="text-sm text-error">
          {state.code}: {state.message}
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            setState({ status: 'loading' })
            setAttempt((old) => old + 1)
          }}
        >
          Retry treemap
        </Button>
      </div>
    )
  if (state.data.children.length === 0)
    return (
      <p className="py-6 text-sm text-text-secondary">
        This directory is empty. No treemap to display.
      </p>
    )
  if (state.data.totalBytes === 0)
    return (
      <div className="space-y-2 py-6 text-sm text-text-secondary">
        <p>
          {state.data.unknownCount ===
          state.data.children.length + (state.data.other?.aggregate.count ?? 0)
            ? 'No sizes available for this directory.'
            : 'No measurable known usage in this directory.'}
        </p>
        {state.data.unknownCount > 0 && (
          <p>
            Sizes unavailable or invalid for {state.data.unknownCount} entries; no positive known
            sizes are available.
          </p>
        )}
        {state.data.zeroCount > 0 && (
          <p>{state.data.zeroCount} entries have a known size of 0 B.</p>
        )}
        {state.data.other && <OtherSummary other={state.data.other.aggregate} />}
      </div>
    )
  return <Treemap data={state.data} {...interactions} />
}
