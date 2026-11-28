import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite'
import { SnapshotAccessError } from './snapshotAccess'

function sizeOverflow(): SnapshotAccessError {
  return new SnapshotAccessError('SIZE_OVERFLOW', 'The file breakdown exceeds the supported size.')
}

export function aggregateInteger(value: SQLOutputValue): number {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid file aggregation result.')
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw sizeOverflow()
  return Number(value)
}

export function readFileAggregateRows(
  statement: StatementSync,
  request: Record<string, SQLInputValue>
): Record<string, SQLOutputValue>[] {
  try {
    return statement.all(request)
  } catch (error) {
    if (error instanceof Error && error.message === 'integer overflow') throw sizeOverflow()
    throw error
  }
}
