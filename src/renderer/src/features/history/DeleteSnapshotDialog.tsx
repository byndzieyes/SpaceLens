import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ScanHistoryErrorCode, ScanHistoryItem } from '../../../../shared/history'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { formatPreciseScanDate } from '../../lib/scanDisplay'
import { formatBytes } from '../../lib/storage'

function deletionError(code: ScanHistoryErrorCode): string {
  switch (code) {
    case 'SNAPSHOT_IN_USE':
      return 'This snapshot is currently in use and cannot be deleted. Close the view using it or wait for any outstanding operation to finish.'
    case 'SNAPSHOT_EXPIRED':
      return 'This snapshot has already been removed.'
    case 'SNAPSHOT_UNAVAILABLE':
    case 'INVALID_REQUEST':
      return 'This saved snapshot is unavailable for deletion.'
    case 'SNAPSHOT_DELETE_UNCERTAIN':
      return 'Deletion could not be confirmed. Restart SpaceLens to recover saved scan storage.'
    case 'UNAVAILABLE':
      return 'Saved scan storage is busy or unavailable. Check History before retrying.'
    default:
      return 'The snapshot could not be deleted.'
  }
}

export function DeleteSnapshotDialog({
  scan,
  latest,
  fallbackFocus,
  onDismiss,
  onDeleted,
  refreshHistory
}: {
  scan: ScanHistoryItem
  latest: boolean
  fallbackFocus: RefObject<HTMLElement | null>
  onDismiss: () => void
  onDeleted: () => void
  refreshHistory: () => void
}): React.JSX.Element {
  const mounted = useRef(false)
  const submitting = useRef(false)
  const restoreFocus = useRef<HTMLElement>(null)
  const getReturnFocus = useCallback(() => restoreFocus.current, [])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ScanHistoryErrorCode>()
  const blocked = error === 'SNAPSHOT_EXPIRED' || error === 'SNAPSHOT_DELETE_UNCERTAIN'
  const acknowledgeError = (code: ScanHistoryErrorCode): void => {
    setError(code)
    if (code === 'SNAPSHOT_EXPIRED' || code === 'SNAPSHOT_DELETE_UNCERTAIN') refreshHistory()
  }

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const confirm = async (): Promise<void> => {
    if (submitting.current || blocked) return
    submitting.current = true
    setPending(true)
    setError(undefined)
    try {
      const result = await window.spaceLens.deleteSnapshot({ scanId: scan.id })
      if (!mounted.current) return
      if (!result.ok) acknowledgeError(result.error.code)
      else if (result.value.scanId !== scan.id) acknowledgeError('SNAPSHOT_DELETE_UNCERTAIN')
      else {
        restoreFocus.current = fallbackFocus.current
        // Main broadcasts the committed revision, including the authoritative Latest.
        onDeleted()
      }
    } catch {
      if (mounted.current) acknowledgeError('SNAPSHOT_DELETE_UNCERTAIN')
    } finally {
      submitting.current = false
      if (mounted.current) setPending(false)
    }
  }

  return (
    <Modal
      title="Delete snapshot?"
      fallbackFocus={fallbackFocus}
      getReturnFocus={getReturnFocus}
      onDismiss={() => {
        if (!submitting.current) onDismiss()
      }}
    >
      <div className="space-y-4">
        <dl className="space-y-2 rounded-md border border-separator bg-background/40 p-3 text-sm">
          <div className="space-y-1">
            <dt className="text-text-secondary">Scan root</dt>
            <dd className="font-medium break-all whitespace-pre-wrap">{scan.rootPath}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-text-secondary">Completed</dt>
            <dd>
              <time dateTime={scan.finishedAt}>{formatPreciseScanDate(scan.finishedAt)}</time>
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-text-secondary">Known logical size</dt>
            <dd>{formatBytes(scan.summary.totalBytes)}</dd>
          </div>
          {latest && (
            <div>
              <dt className="sr-only">Publication</dt>
              <dd>
                <Badge>Latest</Badge>
              </dd>
            </div>
          )}
        </dl>
        <p className="text-sm text-text-secondary">
          This will permanently remove the saved scan results. Your actual files and folders will
          not be deleted.
        </p>
        {latest && (
          <p className="text-sm text-warning">
            The previous retained publication will become Latest. If this is the final snapshot,
            there will be no Latest snapshot.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-error">
            {deletionError(error)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" data-autofocus disabled={pending} onClick={onDismiss}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="danger" disabled={pending || blocked} onClick={() => void confirm()}>
            {pending ? 'Deleting snapshot…' : 'Delete snapshot'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
