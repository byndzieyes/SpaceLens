import type { ScanOutputEvent } from './summary'
import type { ScanFailure } from '../../shared/scan'

/** One batch may be in flight; the worker pauses until Main acknowledges it. */
export const SCANNER_BATCH_SIZE = 128

export interface ScannerWorkerRequest {
  readonly rootPath: string
  readonly scanId: string
}

export type ScannerWorkerFailure = ScanFailure

export interface ScannerWorkerAck {
  readonly type: 'ack'
  readonly scanId: string
  readonly sequence: number
}

export interface ScannerWorkerCancel {
  readonly type: 'cancel'
  readonly scanId: string
}

export type ScannerWorkerMessage =
  | {
      readonly type: 'batch'
      readonly scanId: string
      readonly sequence: number
      readonly events: readonly ScanOutputEvent[]
    }
  | { readonly type: 'complete'; readonly scanId: string }
  | { readonly type: 'cancelled'; readonly scanId: string }
  | { readonly type: 'fatal'; readonly scanId: string; readonly error: ScannerWorkerFailure }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function outputEvent(value: unknown, scanId: string): value is ScanOutputEvent {
  if (!record(value)) return false
  if (value.type === 'error') {
    return (
      record(value.error) &&
      typeof value.error.path === 'string' &&
      nullableString(value.error.code) &&
      typeof value.error.message === 'string'
    )
  }
  if (value.type === 'summary') {
    const summary = value.summary
    return (
      value.scanId === scanId &&
      typeof value.rootEntryId === 'string' &&
      value.rootEntryId.length > 0 &&
      record(summary) &&
      ['fileCount', 'directoryCount', 'totalBytes', 'errorCount'].every((field) =>
        integer(summary[field])
      )
    )
  }
  if (value.type !== 'entry' && value.type !== 'directory-finalized') return false
  const entry = value.entry
  if (
    !record(entry) ||
    entry.scanId !== scanId ||
    typeof entry.id !== 'string' ||
    entry.id.length === 0 ||
    !nullableString(entry.parentId) ||
    typeof entry.path !== 'string' ||
    typeof entry.name !== 'string' ||
    !nullableString(entry.createdAt) ||
    !nullableString(entry.modifiedAt)
  )
    return false
  if (
    typeof entry.type !== 'string' ||
    !['file', 'directory', 'symlink', 'other', 'unknown'].includes(entry.type)
  )
    return false
  if (
    entry.type === 'file'
      ? entry.sizeBytes !== null && !integer(entry.sizeBytes)
      : entry.sizeBytes !== null
  )
    return false
  return value.type === 'entry'
    ? entry.aggregatedSizeBytes === null
    : entry.type === 'directory' && integer(entry.aggregatedSizeBytes)
}

export function parseScannerWorkerRequest(value: unknown): ScannerWorkerRequest {
  if (
    !record(value) ||
    typeof value.rootPath !== 'string' ||
    value.rootPath.length === 0 ||
    typeof value.scanId !== 'string' ||
    value.scanId.trim().length === 0
  ) {
    throw new TypeError('Scanner worker requires a root path and a non-empty scan ID.')
  }
  return { rootPath: value.rootPath, scanId: value.scanId }
}

export function parseScannerWorkerMessage(value: unknown, scanId: string): ScannerWorkerMessage {
  if (!record(value) || value.scanId !== scanId) throw new Error('Invalid scanner worker scan ID.')
  if (value.type === 'complete') return { type: 'complete', scanId }
  if (value.type === 'cancelled') return { type: 'cancelled', scanId }
  if (
    value.type === 'fatal' &&
    record(value.error) &&
    typeof value.error.name === 'string' &&
    typeof value.error.message === 'string' &&
    nullableString(value.error.code)
  ) {
    return {
      type: 'fatal',
      scanId,
      error: { name: value.error.name, message: value.error.message, code: value.error.code }
    }
  }
  if (
    value.type === 'batch' &&
    integer(value.sequence) &&
    Array.isArray(value.events) &&
    value.events.length > 0 &&
    value.events.length <= SCANNER_BATCH_SIZE &&
    value.events.every((event) => outputEvent(event, scanId))
  ) {
    return { type: 'batch', scanId, sequence: value.sequence, events: value.events }
  }
  throw new Error('Invalid scanner worker message.')
}

export function isScannerWorkerAck(
  value: unknown,
  scanId: string,
  sequence: number
): value is ScannerWorkerAck {
  return (
    record(value) && value.type === 'ack' && value.scanId === scanId && value.sequence === sequence
  )
}

export function isScannerWorkerCancel(
  value: unknown,
  scanId: string
): value is ScannerWorkerCancel {
  return record(value) && value.type === 'cancel' && value.scanId === scanId
}

export function serializeWorkerFailure(error: unknown): ScannerWorkerFailure {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    code:
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null
  }
}
