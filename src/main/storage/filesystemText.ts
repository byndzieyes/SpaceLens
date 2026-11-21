import type { SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'

// UTF-16BE preserves filesystem code units, including lone surrogates, and their sort order.
export function bindFilesystemText(value: string): Buffer {
  return Buffer.from(value, 'utf16le').swap16()
}

export function readFilesystemText(value: SQLOutputValue, column: string): string {
  if (!types.isUint8Array(value) || value.byteLength % 2 !== 0) {
    throw new TypeError(`Stored ${column} must be a UTF-16 BLOB.`)
  }
  return Buffer.from(value).swap16().toString('utf16le')
}
