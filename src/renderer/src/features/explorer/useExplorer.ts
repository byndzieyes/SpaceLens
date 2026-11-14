import { useEffect, useRef, useState } from 'react'
import type { ScannerIpcResult } from '../../../../shared/ipc'
import type { FileEntry } from '../../../../shared/scan'
import { resolveExplorerSnapshot, type ExplorerSnapshotState } from './data'

type AccessError = Extract<ScannerIpcResult<never>, { ok: false }>['error']
export interface ExplorerState {
  availability: ExplorerSnapshotState | null
  breadcrumbs: readonly FileEntry[]
  selectedEntryId: string | null
  back: readonly string[]
  forward: readonly string[]
  loading: boolean
  error: AccessError | { code: 'TRANSPORT_ERROR'; message: string } | null
}
const initial: ExplorerState = {
  availability: null,
  breadcrumbs: [],
  selectedEntryId: null,
  back: [],
  forward: [],
  loading: true,
  error: null
}
const invalid = (message: string): AccessError => ({ code: 'INVALID_REQUEST', message })

export function useExplorer(): ExplorerState & {
  currentDirectoryId: string | null
  navigateToDirectory: (id: string) => Promise<void>
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  goUp: () => Promise<void>
  selectEntry: (id: string | null) => void
  refreshSnapshot: () => Promise<void>
} {
  const [state, setState] = useState<ExplorerState>(initial)
  const current = useRef(state)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const publish = (next: ExplorerState): void => {
    current.current = next
    setState(next)
  }
  const refreshSnapshot = async (): Promise<void> => {
    const ticket = ++sequence.current
    publish({ ...current.current, loading: true, error: null })
    try {
      const result = await resolveExplorerSnapshot()
      if (!mounted.current || ticket !== sequence.current) return
      if (!result.ok) {
        publish({ ...current.current, loading: false, error: result.error })
        return
      }
      const previous = current.current
      const availability = result.value
      const same =
        availability.status === 'available' &&
        previous.availability?.status === 'available' &&
        availability.snapshot.entries.scanId === previous.availability.snapshot.entries.scanId
      publish({
        ...(same ? previous : initial),
        availability,
        loading: false,
        error: null,
        breadcrumbs: same
          ? previous.breadcrumbs
          : availability.status === 'available'
            ? [availability.snapshot.root]
            : []
      })
    } catch {
      if (mounted.current && ticket === sequence.current)
        publish({
          ...current.current,
          loading: false,
          error: {
            code: 'TRANSPORT_ERROR',
            message: 'Snapshot availability could not be loaded. Retry the request.'
          }
        })
    }
  }
  useEffect(() => {
    const requests = sequence
    mounted.current = true
    void refreshSnapshot()
    return () => {
      mounted.current = false
      requests.current++
    }
    // Availability is queried on activation; refresh is an explicit action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const navigate = async (
    entryId: string,
    mode: 'new' | 'back' | 'forward' = 'new'
  ): Promise<void> => {
    const before = current.current
    if (before.availability?.status !== 'available') return
    const snapshot = before.availability.snapshot
    const oldId = before.breadcrumbs.at(-1)?.id
    const ticket = ++sequence.current
    if (entryId === oldId) {
      publish({ ...before, loading: false })
      return
    }
    publish({ ...before, loading: true, error: null })
    try {
      const chain: FileEntry[] = []
      const seen = new Set<string>()
      let id: string | null = entryId
      // Bound requests even for malformed or exceptionally deep snapshots.
      while (id !== null && chain.length < 256) {
        if (seen.has(id)) throw invalid('Directory ancestry contains a cycle.')
        seen.add(id)
        let entry: FileEntry
        if (id === snapshot.root.id) entry = snapshot.root
        else {
          const result = await window.spaceLens.getScanEntry({
            scanId: snapshot.entries.scanId,
            entryId: id
          })
          if (!mounted.current || ticket !== sequence.current) return
          if (!result.ok) throw result.error
          entry = result.value
        }
        if (entry.scanId !== snapshot.entries.scanId || entry.id !== id)
          throw invalid('Entry identity does not match this snapshot.')
        if (entry.type !== 'directory')
          throw {
            code: 'NOT_DIRECTORY',
            message: 'Only directories can be opened.'
          } satisfies AccessError
        chain.push(entry)
        if (entry.id === snapshot.root.id) break
        id = entry.parentId
      }
      if (chain.at(-1)?.id !== snapshot.root.id)
        throw invalid(
          'Directory ancestry could not be resolved within the snapshot root (maximum depth 256).'
        )
      if (!mounted.current || ticket !== sequence.current) return
      publish({
        ...before,
        breadcrumbs: chain.reverse(),
        selectedEntryId: null,
        loading: false,
        error: null,
        back: mode === 'back' ? before.back.slice(0, -1) : [...before.back, oldId!],
        forward:
          mode === 'forward'
            ? before.forward.slice(0, -1)
            : mode === 'back'
              ? [...before.forward, oldId!]
              : []
      })
    } catch (error) {
      if (!mounted.current || ticket !== sequence.current) return
      const failure =
        error && typeof error === 'object' && 'code' in error && 'message' in error
          ? (error as AccessError)
          : {
              code: 'TRANSPORT_ERROR' as const,
              message: 'Directory could not be loaded. Retry the request.'
            }
      publish({ ...before, loading: false, error: failure })
      if (failure.code === 'SNAPSHOT_EXPIRED' || failure.code === 'SNAPSHOT_UNAVAILABLE') {
        await refreshSnapshot()
        if (mounted.current && sequence.current === ticket + 1)
          publish({ ...current.current, error: current.current.error ?? failure })
      }
    }
  }
  return {
    ...state,
    currentDirectoryId: state.breadcrumbs.at(-1)?.id ?? null,
    navigateToDirectory: (id: string) => navigate(id),
    goBack: () => {
      const id = current.current.back.at(-1)
      return id ? navigate(id, 'back') : Promise.resolve()
    },
    goForward: () => {
      const id = current.current.forward.at(-1)
      return id ? navigate(id, 'forward') : Promise.resolve()
    },
    goUp: () => {
      const id = current.current.breadcrumbs.at(-2)?.id
      return id ? navigate(id) : Promise.resolve()
    },
    selectEntry: (id: string | null) =>
      publish({
        ...current.current,
        selectedEntryId: current.current.availability?.status === 'available' ? id : null
      }),
    refreshSnapshot
  }
}
