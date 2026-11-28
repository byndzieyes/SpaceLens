import type { ComparisonPair } from '../../shared/comparison'
import { readComparisonPair } from './comparisonSummaryContracts'
import { integer, record } from './payloads'
import { SnapshotAccessError } from './snapshotAccess'

export interface ComparisonPreparationRequest {
  readonly pair: ComparisonPair
  readonly id: string
  readonly action: 'start' | 'advance' | 'discard'
  readonly scope: 'workspace' | 'directories'
}

export interface ComparisonPreparationStatus {
  readonly phase: 'matching' | 'classifying' | 'directories' | 'ready'
  readonly completed: number
}

export function readComparisonPreparation(value: unknown): ComparisonPreparationRequest {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) ||
    (value.action !== 'start' && value.action !== 'advance' && value.action !== 'discard') ||
    (value.scope !== 'workspace' && value.scope !== 'directories')
  )
    throw new SnapshotAccessError('INVALID_REQUEST', 'Invalid comparison preparation.')
  return {
    id: value.id,
    action: value.action,
    scope: value.scope,
    pair: readComparisonPair(value.pair)
  }
}

export function isComparisonPreparationStatus(
  value: unknown
): value is ComparisonPreparationStatus {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    (value.phase === 'matching' ||
      value.phase === 'classifying' ||
      value.phase === 'directories' ||
      value.phase === 'ready') &&
    integer(value.completed)
  )
}
