import type { SQLOutputValue } from 'node:sqlite'
import type { FileEntry, FileEntryType } from '../../shared/scan'
import { readFilesystemText } from './filesystemText'

export const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

export function readInteger(value: SQLOutputValue, column: string): number {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_SAFE_INTEGER) {
    throw new RangeError(`Stored ${column} is outside the non-negative safe integer range.`)
  }
  return Number(value)
}

export function readText(value: SQLOutputValue, column: string): string {
  if (typeof value !== 'string') throw new TypeError(`Stored ${column} must be text.`)
  return value
}

export function readEntryType(value: SQLOutputValue): FileEntryType {
  switch (value) {
    case 'file':
    case 'directory':
    case 'symlink':
    case 'other':
    case 'unknown':
      return value
    default:
      throw new Error('Stored entry has an invalid type.')
  }
}

const columns = [
  'scan_id',
  'id',
  'parent_id',
  'name',
  'path',
  'type',
  'size_bytes',
  'aggregated_size_bytes',
  'created_at',
  'modified_at'
]

export function entryColumns(alias: 'entry' | 'baseline' | 'target', prefix = ''): string {
  return columns.map((column) => `${alias}.${column} AS ${prefix}${column}`).join(', ')
}

export function readEntry(row: Record<string, SQLOutputValue>, prefix = ''): FileEntry {
  const {
    scan_id,
    id,
    parent_id,
    name,
    path,
    type,
    size_bytes,
    aggregated_size_bytes,
    created_at,
    modified_at
  } = prefix ? Object.fromEntries(columns.map((column) => [column, row[prefix + column]])) : row
  return {
    id: readText(id, 'entry ID'),
    scanId: readText(scan_id, 'scan ID'),
    parentId: parent_id === null ? null : readText(parent_id, 'parent ID'),
    name: readFilesystemText(name, 'name'),
    path: readFilesystemText(path, 'path'),
    type: readEntryType(type),
    sizeBytes: size_bytes === null ? null : readInteger(size_bytes, 'sizeBytes'),
    aggregatedSizeBytes:
      aggregated_size_bytes === null
        ? null
        : readInteger(aggregated_size_bytes, 'aggregatedSizeBytes'),
    createdAt: created_at === null ? null : readText(created_at, 'createdAt'),
    modifiedAt: modified_at === null ? null : readText(modified_at, 'modifiedAt')
  }
}
