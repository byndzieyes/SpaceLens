import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  ComparisonErrorCode,
  ComparisonPair,
  ComparisonReadRequest
} from '../shared/comparison'
import { IPC_CHANNELS, type ScannerIpcResult } from '../shared/ipc'
import { readComparisonDirectoryQuery } from './storage/comparisonDirectoryContracts'
import { readComparisonFileQuery } from './storage/comparisonFileContracts'
import { ComparisonStorageError } from './storage/comparisonMatchContracts'
import type { ComparisonSelection } from './storage/comparisonSelection'
import { readComparisonPair } from './storage/comparisonSummaryContracts'
import { StorageSchedulingError, StorageUnavailableError } from './storage/coordinator'
import { record } from './storage/payloads'
import { SnapshotAccessError } from './storage/snapshotAccess'
import { StorageRequestTimeoutError, StorageWorkerError } from './storage/workerClient'

const messages = {
  UNAUTHORIZED: 'Comparison access is not authorized.',
  COMPARISON_SCAN_ACTIVE: 'Comparison is available after the scan finishes.',
  COMPARISON_TIMEOUT: 'The comparison request timed out.',
  UNAVAILABLE:
    'Saved scan storage or the comparison request is no longer available. Retry the request.',
  INTERNAL_ERROR: 'The comparison request could not be processed.',
  INVALID_REQUEST: 'Invalid comparison request.',
  SNAPSHOT_EXPIRED: 'A comparison snapshot expired or the selection changed.',
  SNAPSHOT_UNAVAILABLE: 'A comparison snapshot or selection is unavailable.',
  SNAPSHOT_IN_USE: 'A comparison snapshot is in use.',
  SIZE_OVERFLOW: 'The comparison totals exceed the supported numeric range.',
  INCOMPATIBLE_SNAPSHOTS: 'These saved scans are incompatible.',
  INVALID_COMPARISON_PATH: 'A saved scan contains an invalid comparison path.',
  AMBIGUOUS_COMPARISON_PATH: 'A saved scan contains ambiguous comparison paths.'
} satisfies Record<ComparisonErrorCode, string>

function failure(code: ComparisonErrorCode): ScannerIpcResult<never, ComparisonErrorCode> {
  return { ok: false, error: { code, message: messages[code] } }
}

function comparisonFailure(error: unknown): ScannerIpcResult<never, ComparisonErrorCode> {
  if (error instanceof StorageRequestTimeoutError) return failure('COMPARISON_TIMEOUT')
  if (error instanceof StorageSchedulingError && error.code === 'COMPARISON_SCAN_ACTIVE')
    return failure('COMPARISON_SCAN_ACTIVE')
  if (error instanceof StorageUnavailableError) return failure('UNAVAILABLE')
  if (
    error instanceof SnapshotAccessError ||
    error instanceof ComparisonStorageError ||
    (error instanceof StorageWorkerError &&
      (error.name === 'SnapshotAccessError' || error.name === 'ComparisonStorageError'))
  ) {
    const { code } = error
    switch (code) {
      case 'INVALID_REQUEST':
      case 'SNAPSHOT_EXPIRED':
      case 'SNAPSHOT_UNAVAILABLE':
      case 'SNAPSHOT_IN_USE':
      case 'SIZE_OVERFLOW':
      case 'INCOMPATIBLE_SNAPSHOTS':
      case 'INVALID_COMPARISON_PATH':
      case 'AMBIGUOUS_COMPARISON_PATH':
        return failure(code)
    }
  }
  return failure('INTERNAL_ERROR')
}

function fields(value: unknown, ...keys: string[]): Record<string, unknown> {
  if (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.hasOwn(value, k))
  )
    return value
  throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid comparison request.')
}

function identity(value: unknown): string {
  if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    return value
  throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid comparison identity.')
}

function readRequest<Query extends ComparisonPair>(
  value: unknown,
  parse: (query: unknown) => Query
): ComparisonReadRequest<Query> {
  const { selectionId, query } = fields(value, 'selectionId', 'query')
  return { selectionId: identity(selectionId), query: parse(query) }
}

const commands = {
  evaluateComparisonCompatibility: async (slot: ComparisonSelection, value: unknown) => ({
    value: await slot.evaluate(readComparisonPair(value))
  }),
  prepareComparisonSelection: (slot: ComparisonSelection, value: unknown) =>
    slot.prepare(readComparisonPair(value)),
  adoptComparisonSelection: (slot: ComparisonSelection, value: unknown) =>
    slot.adopt(identity(fields(value, 'ticket').ticket)),
  discardPreparedComparisonSelection: (slot: ComparisonSelection, value: unknown) => {
    slot.discard(identity(fields(value, 'ticket').ticket))
    return { value: null }
  },
  releaseComparisonSelection: (slot: ComparisonSelection, value: unknown) => {
    const { selectionId } = fields(value, 'selectionId')
    slot.release(selectionId === null ? null : identity(selectionId))
    return { value: null }
  },
  getComparisonSummary: (slot: ComparisonSelection, value: unknown) => {
    const { selectionId, query } = readRequest(value, readComparisonPair)
    return slot.read(selectionId, query, (client) => client.getComparisonSummary(query))
  },
  listComparisonFileChanges: (slot: ComparisonSelection, value: unknown) => {
    const { selectionId, query } = readRequest(value, readComparisonFileQuery)
    return slot.read(selectionId, query, (client) => client.listComparisonFileChanges(query))
  },
  listComparisonDirectoryChanges: (slot: ComparisonSelection, value: unknown) => {
    const { selectionId, query } = readRequest(value, readComparisonDirectoryQuery)
    return slot.read(
      selectionId,
      query,
      (client) => client.listComparisonDirectoryChanges(query),
      query.kinds?.length === 0 ? 'workspace' : 'directories'
    )
  }
}

export function registerComparisonIpc(
  authorizedSlot: (event: IpcMainInvokeEvent) => ComparisonSelection | undefined,
  disposed: () => boolean
): () => void {
  const names = Object.keys(commands) as (keyof typeof commands)[]
  for (const name of names) {
    ipcMain.handle(IPC_CHANNELS[name], async (event, ...args: unknown[]) => {
      if (disposed()) return failure('UNAVAILABLE')
      const slot = authorizedSlot(event)
      if (!slot) return failure('UNAUTHORIZED')
      if (args.length !== 1) return failure('INVALID_REQUEST')
      const current = (): boolean => authorizedSlot(event) === slot
      try {
        const reply = await commands[name](slot, args[0])
        if (!current()) return failure('UNAVAILABLE')
        if ('verify' in reply) reply.verify()
        return { ok: true, value: reply.value }
      } catch (error) {
        return current() ? comparisonFailure(error) : failure('UNAVAILABLE')
      }
    })
  }
  return () => {
    for (const name of names) ipcMain.removeHandler(IPC_CHANNELS[name])
  }
}
