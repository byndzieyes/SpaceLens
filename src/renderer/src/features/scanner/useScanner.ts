import { useEffect, useRef, useState } from 'react'
import type { ScannerIpcErrorCode, ScanStateSnapshot } from '../../../../shared/ipc'
import type { ScanSessionState } from '../../../../shared/scan'

interface ScanView {
  scan: ScanSessionState | null
  ready: boolean
  pending: 'selecting' | 'starting' | null
  cancelling: string | null
  notice: string | null
  error: string | null
}

const initialView: ScanView = {
  scan: null,
  ready: false,
  pending: null,
  cancelling: null,
  notice: null,
  error: null
}

function requestError(code: ScannerIpcErrorCode): string {
  switch (code) {
    case 'PATH_NOT_AUTHORIZED':
    case 'DIRECTORY_UNAVAILABLE':
      return 'This directory is no longer approved or accessible. Select the directory again.'
    case 'SCAN_ACTIVE':
      return 'A scan is already active. Wait for it to finish before starting another.'
    case 'PICKER_BUSY':
      return 'A folder picker is already open. Finish that selection first.'
    case 'PICKER_FAILED':
      return 'The folder picker could not be opened. Please try again.'
    case 'SCAN_MISMATCH':
    case 'NOT_RUNNING':
      return 'That scan is no longer running. Its latest status is shown below.'
    default:
      return 'The scanner request could not be completed. Please try again.'
  }
}

/** Metadata only. Main owns the scan and continues working when Overview unmounts. */
export function useScanner(): ScanView & {
  select: () => void
  cancel: () => void
  refresh: () => void
} {
  const [view, setView] = useState(initialView)
  const actions = useRef<{
    select: () => Promise<void>
    cancel: () => Promise<void>
    refresh: () => Promise<void>
  } | null>(null)

  useEffect(() => {
    let active = true
    let current = initialView
    let revision = -1
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    const api = window.spaceLens
    const update = (patch: Partial<ScanView>, progressOnly = false): void => {
      if (!active) return
      current = { ...current, ...patch }
      if (progressOnly) {
        // Retain only the latest counters and render at most ten progress samples
        // per second. Actions and terminal states always publish immediately.
        progressTimer ??= setTimeout(() => {
          progressTimer = undefined
          if (active) setView(current)
        }, 100)
      } else {
        clearTimeout(progressTimer)
        progressTimer = undefined
        setView(current)
      }
    }
    const accept = (snapshot: ScanStateSnapshot): void => {
      if (!active || snapshot.revision <= revision) return
      const scan = snapshot.state
      if (scan && scan.progress.scanId !== scan.session.id) return
      revision = snapshot.revision
      const progressOnly =
        scan?.session.status === 'running' &&
        current.scan?.session.status === 'running' &&
        current.scan.session.id === scan.session.id &&
        current.ready
      update(
        {
          scan,
          ready: true,
          cancelling:
            scan?.session.status === 'running' && scan.session.id === current.cancelling
              ? current.cancelling
              : null
        },
        progressOnly
      )
    }
    const refresh = async (): Promise<void> => {
      if (!active) return
      const requestedAt = revision
      try {
        const result = await api.getScanState()
        if (!active) return
        if (result.ok) accept(result.value)
        else if (revision === requestedAt) update({ error: requestError(result.error.code) })
      } catch {
        if (revision === requestedAt)
          update({ error: 'Scan status could not be loaded. Refresh the status to try again.' })
      }
    }
    const select = async (): Promise<void> => {
      if (
        !active ||
        !current.ready ||
        current.pending ||
        current.scan?.session.status === 'running'
      )
        return
      update({ pending: 'selecting', notice: null, error: null })
      try {
        const selection = await api.selectScanDirectory()
        if (!active) return
        if (!selection.ok) {
          update({ error: requestError(selection.error.code) })
          return
        }
        if (selection.value.cancelled) {
          update({ notice: 'Folder selection cancelled. No new scan was started.' })
          return
        }
        update({ pending: 'starting' })
        const result = await api.startScan({ rootPath: selection.value.rootPath })
        if (!active) return
        if (!result.ok) update({ error: requestError(result.error.code) })
        // Never invent a running session from an acceptance response. It may already
        // have finished, or a newer session may have arrived through the subscription.
        else if (current.scan?.session.id !== result.value.scanId) update({ ready: false })
        await refresh()
      } catch {
        update({
          error: 'The scan request could not be completed. Refresh the status before retrying.',
          ready: false
        })
        await refresh()
      } finally {
        update({ pending: null })
      }
    }
    const cancel = async (): Promise<void> => {
      const scan = current.scan
      if (!active || !scan || scan.session.status !== 'running' || current.cancelling) return
      const scanId = scan.session.id
      update({ cancelling: scanId, notice: null, error: null })
      try {
        const result = await api.cancelScan({ scanId })
        if (
          !active ||
          current.scan?.session.id !== scanId ||
          current.scan.session.status !== 'running'
        )
          return
        if (!result.ok) {
          update({ cancelling: null, error: requestError(result.error.code) })
          await refresh()
        }
        // Keep 'cancelling' until a terminal snapshot confirms worker settlement.
      } catch {
        if (current.scan?.session.id === scanId && current.scan.session.status === 'running') {
          update({
            cancelling: null,
            error: 'Cancellation could not be requested. Please try again.'
          })
        }
      }
    }
    actions.current = {
      select,
      cancel,
      refresh: async () => {
        update({ error: null })
        await refresh()
      }
    }
    let unsubscribe: (() => void) | undefined
    try {
      // Subscribe first so the initial query cannot leave a gap in updates.
      unsubscribe = api.onScanStateChanged(accept)
      void refresh()
    } catch {
      update({ error: 'The scanner is unavailable. Reopen the application to try again.' })
    }
    return () => {
      active = false
      clearTimeout(progressTimer)
      actions.current = null
      unsubscribe?.()
    }
  }, [])

  return {
    ...view,
    select: () => {
      void actions.current?.select()
    },
    cancel: () => {
      void actions.current?.cancel()
    },
    refresh: () => {
      void actions.current?.refresh()
    }
  }
}
