import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import {
  isScanHistoryRetentionSettings,
  type ScanHistoryRetentionSettings
} from '../../../../shared/history'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'

export interface HistoryFeedback {
  readonly status: 'success' | 'error'
  readonly message: string
}

type SettingsState =
  { status: 'loading' | 'unavailable' | 'repair' } | { status: 'ready'; limit: number }

const counts = new Intl.NumberFormat('en-US')
const savedMessage = 'History retention limit saved.'
const failedMessage = 'The retention limit could not be saved. Check the setting and try again.'

function retentionDraft(draft: string): ScanHistoryRetentionSettings | undefined {
  const settings = { maxCompletedSnapshots: Number(draft) }
  return /^[0-9]+$/.test(draft) && isScanHistoryRetentionSettings(settings) ? settings : undefined
}

export function HistorySettings({
  retainedCount,
  historyRevision,
  onOpen,
  report
}: {
  retainedCount?: number
  historyRevision: number
  onOpen: () => void
  report: (feedback: HistoryFeedback) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<SettingsState>({ status: 'loading' })
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<HistoryFeedback>()
  const [fallbackCount, setFallbackCount] = useState<{ revision: number; count: number }>()
  const count =
    retainedCount ?? (fallbackCount?.revision === historyRevision ? fallbackCount.count : undefined)
  const loadedLimit = settings.status === 'ready' ? settings.limit : undefined
  const value = retentionDraft(draft)
  const canEdit = settings.status === 'ready' || settings.status === 'repair'
  const canSave = canEdit && !!value && value.maxCompletedSnapshots !== loadedLimit && !saving
  const reduction =
    loadedLimit !== undefined && !!value && value.maxCompletedSnapshots < loadedLimit
  const mounted = useRef(false)
  const showing = useRef(false)
  const savingRequest = useRef(false)
  const keepDraft = useRef(false)
  const loadingRequest = useRef<symbol>(undefined)
  const back = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const getReturnFocus = useCallback(() => trigger.current, [])
  const input = useRef<HTMLInputElement>(null)
  const wasConfirming = useRef(false)

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      loadingRequest.current = undefined
    }
  }, [])

  useLayoutEffect(() => {
    if (open && confirming) back.current?.focus()
    else if (open && wasConfirming.current) input.current?.focus()
    wasConfirming.current = confirming
  }, [confirming, open])

  useEffect(() => {
    if (!open || retainedCount !== undefined) return
    let active = true
    void window.spaceLens
      .listScanHistory({ limit: 1 })
      .then((result) => {
        if (active && result.ok)
          setFallbackCount({ revision: historyRevision, count: result.value.totalCount })
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [historyRevision, open, retainedCount])

  const load = async (): Promise<void> => {
    const request = Symbol()
    loadingRequest.current = request
    setSettings({ status: 'loading' })
    try {
      const result = await window.spaceLens.getRetentionSettings()
      if (loadingRequest.current !== request) return
      if (result.ok && isScanHistoryRetentionSettings(result.value)) {
        const limit = result.value.maxCompletedSnapshots
        setSettings({ status: 'ready', limit })
        if (!keepDraft.current) setDraft(String(limit))
      } else if (result.ok || result.error.code === 'INTERNAL_ERROR') {
        setSettings({ status: 'repair' })
        if (!keepDraft.current) setDraft('')
      } else {
        setSettings({ status: 'unavailable' })
      }
    } catch {
      if (loadingRequest.current === request) setSettings({ status: 'unavailable' })
    }
  }

  const dismiss = (): void => {
    showing.current = false
    loadingRequest.current = undefined
    setOpen(false)
    setConfirming(false)
  }

  const save = async (next: ScanHistoryRetentionSettings): Promise<void> => {
    if (savingRequest.current) return
    savingRequest.current = true
    setSaving(true)
    setFeedback(undefined)
    const notify = (result: HistoryFeedback): void => {
      if (showing.current) setFeedback(result)
      else report(result)
    }
    try {
      const result = await window.spaceLens.setRetentionSettings(next)
      if (!mounted.current) return
      if (!result.ok || !isScanHistoryRetentionSettings(result.value))
        throw new Error(failedMessage)
      const limit = result.value.maxCompletedSnapshots
      setSettings({ status: 'ready', limit })
      setDraft(String(limit))
      keepDraft.current = false
      notify({ status: 'success', message: savedMessage })
    } catch {
      if (mounted.current) {
        keepDraft.current = true
        notify({ status: 'error', message: failedMessage })
      }
    } finally {
      savingRequest.current = false
      if (mounted.current) {
        setSaving(false)
        setConfirming(false)
      }
    }
  }

  return (
    <>
      <Button
        ref={trigger}
        variant="secondary"
        onClick={() => {
          onOpen()
          showing.current = true
          setOpen(true)
          if (!savingRequest.current) {
            setFeedback(undefined)
            void load()
          }
        }}
      >
        <Settings2 size={16} aria-hidden="true" /> History Settings
      </Button>
      {open && (
        <Modal
          title={
            confirming
              ? reduction
                ? 'Reduce retention limit?'
                : 'Apply retention limit?'
              : 'History Settings'
          }
          onDismiss={dismiss}
          getReturnFocus={getReturnFocus}
        >
          {confirming && value ? (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                Saving a limit of {counts.format(value.maxCompletedSnapshots)} may automatically
                remove older unprotected snapshots. Latest and protected snapshots are excluded.
                Removed scan results cannot be restored through History. Your files and folders will
                remain on disk.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  ref={back}
                  variant="secondary"
                  disabled={saving}
                  onClick={() => setConfirming(false)}
                >
                  Back
                </Button>
                <Button variant="danger" disabled={saving} onClick={() => void save(value)}>
                  {saving ? 'Saving…' : reduction ? 'Reduce limit' : 'Apply limit'}
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (!canSave || !value || savingRequest.current) return
                if (reduction || settings.status === 'repair') setConfirming(true)
                else void save(value)
              }}
            >
              {settings.status === 'loading' && (
                <p role="status" className="text-sm text-text-secondary">
                  Loading retention settings…
                </p>
              )}
              {settings.status === 'unavailable' && (
                <div className="flex flex-wrap items-center gap-3">
                  <p role="alert" className="text-sm text-error">
                    Retention settings are unavailable.
                  </p>
                  <Button variant="secondary" onClick={() => void load()}>
                    Retry
                  </Button>
                </div>
              )}
              {settings.status === 'repair' && (
                <p role="alert" className="text-sm text-error">
                  Saved retention settings could not be restored. Save a valid limit to resume
                  pruning.
                </p>
              )}
              {canEdit && (
                <div className="space-y-2">
                  <label htmlFor="history-retention-limit" className="block text-sm font-medium">
                    Maximum retained snapshots
                  </label>
                  <input
                    ref={input}
                    id="history-retention-limit"
                    type="text"
                    inputMode="numeric"
                    value={draft}
                    disabled={saving}
                    aria-invalid={!value}
                    aria-describedby={!value ? 'history-retention-validation' : undefined}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm tabular-nums"
                  />
                  {!value && (
                    <p id="history-retention-validation" className="text-sm text-error">
                      Enter a whole number from 1 to {counts.format(Number.MAX_SAFE_INTEGER)}.
                    </p>
                  )}
                  {loadedLimit !== undefined && (
                    <p className="text-xs text-text-secondary">
                      Saved limit {counts.format(loadedLimit)}
                    </p>
                  )}
                </div>
              )}
              {count !== undefined && (
                <p className="text-sm">Retained snapshots {counts.format(count)}</p>
              )}
              <p className="text-sm text-text-secondary">
                When the target is exceeded, SpaceLens removes older eligible scan results. Latest
                and protected snapshots are kept. Your files and folders remain on disk.
              </p>
              {count !== undefined && loadedLimit !== undefined && count > loadedLimit && (
                <p className="text-sm text-warning">
                  Some snapshots may be retained temporarily while they are in use or cleanup is
                  pending.
                </p>
              )}
              {feedback && (
                <p
                  role={feedback.status === 'error' ? 'alert' : 'status'}
                  className={
                    feedback.status === 'error' ? 'text-sm text-error' : 'text-sm text-success'
                  }
                >
                  {feedback.message}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={dismiss}>
                  Close
                </Button>
                <Button type="submit" disabled={!canSave}>
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </>
  )
}
