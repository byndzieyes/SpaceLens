import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BuildingScan, CompletedScan } from '../src/main/storage/payloads'
import type { FileEntry, ScanSession } from '../src/shared/scan'

// Exact CREATE statements recorded by Phase 4. Keep this fixture independent of schema.ts.
const schema = {
  scans: `CREATE TABLE scans (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
    root_path BLOB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    file_count INTEGER NOT NULL CHECK (file_count >= 0),
    directory_count INTEGER NOT NULL CHECK (directory_count >= 0),
    error_count INTEGER NOT NULL CHECK (error_count >= 0),
    CONSTRAINT scan_finish_time CHECK ((status = 'running') = (finished_at IS NULL))
  ) STRICT`,
  entries: `CREATE TABLE entries (
    scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (length(id) > 0),
    parent_id TEXT,
    name BLOB NOT NULL,
    path BLOB NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('file', 'directory', 'symlink', 'other', 'unknown')),
    size_bytes INTEGER,
    aggregated_size_bytes INTEGER,
    created_at TEXT,
    modified_at TEXT,
    parent_type TEXT GENERATED ALWAYS AS ('directory') VIRTUAL,
    PRIMARY KEY (scan_id, id),
    UNIQUE (scan_id, id, type),
    FOREIGN KEY (scan_id, parent_id, parent_type) REFERENCES entries(scan_id, id, type),
    CONSTRAINT entry_root_directory CHECK (parent_id IS NOT NULL OR type = 'directory'),
    CONSTRAINT entry_parent_identity CHECK (parent_id IS NULL OR parent_id <> id),
    CONSTRAINT entry_file_size CHECK (size_bytes IS NULL OR (type = 'file' AND size_bytes >= 0)),
    CONSTRAINT entry_directory_size CHECK (
      aggregated_size_bytes IS NULL OR (type = 'directory' AND aggregated_size_bytes >= 0)
    )
  ) STRICT`,
  entries_one_root_per_scan: `CREATE UNIQUE INDEX entries_one_root_per_scan
    ON entries(scan_id) WHERE parent_id IS NULL`,
  entries_by_parent: `CREATE INDEX entries_by_parent ON entries(scan_id, parent_id)`
}

export function createV1Database(path: string): DatabaseSync {
  const sql = new DatabaseSync(path)
  sql.exec(Object.values(schema).join(';\n'))
  sql.exec('PRAGMA user_version = 1')
  return sql
}

function filesystemText(value: string): Buffer {
  return Buffer.from(value, 'utf16le').swap16()
}

export function seedV1Scan(
  sql: DatabaseSync,
  scan: ScanSession,
  entries: readonly FileEntry[] = []
): void {
  const { totalBytes, fileCount, directoryCount, errorCount } = scan.summary
  sql
    .prepare(
      `
    INSERT INTO scans (
      id, root_path, status, started_at, finished_at, total_bytes, file_count,
      directory_count, error_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      scan.id,
      filesystemText(scan.rootPath),
      scan.status,
      scan.startedAt,
      scan.finishedAt,
      totalBytes,
      fileCount,
      directoryCount,
      errorCount
    )

  const insert = sql.prepare(`
    INSERT INTO entries (
      scan_id, id, parent_id, name, path, type, size_bytes, aggregated_size_bytes, created_at, modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const entry of entries) {
    insert.run(
      entry.scanId,
      entry.id,
      entry.parentId,
      filesystemText(entry.name),
      filesystemText(entry.path),
      entry.type,
      entry.sizeBytes,
      entry.aggregatedSizeBytes,
      entry.createdAt,
      entry.modifiedAt
    )
  }
}

export const legacyScan: CompletedScan = {
  id: 'legacy',
  rootPath: resolve('migration-fixture'),
  status: 'completed',
  startedAt: '2026-11-20T15:00:00.000+02:00',
  finishedAt: '2026-11-20T13:15:00.000Z',
  summary: { totalBytes: 25, fileCount: 2, directoryCount: 2, errorCount: 1 }
}

const root: FileEntry = {
  id: 'root',
  scanId: legacyScan.id,
  parentId: null,
  name: 'migration-fixture',
  path: legacyScan.rootPath,
  type: 'directory',
  sizeBytes: null,
  aggregatedSizeBytes: 25,
  createdAt: null,
  modifiedAt: legacyScan.finishedAt
}
const folder: FileEntry = {
  ...root,
  id: 'folder',
  name: 'photos',
  path: join(root.path, 'photos'),
  parentId: root.id
}
const image: FileEntry = {
  id: 'image',
  scanId: legacyScan.id,
  parentId: folder.id,
  name: "photo '📁' \ud800.png",
  path: join(folder.path, "photo '📁' \ud800.png"),
  type: 'file',
  sizeBytes: 25,
  aggregatedSizeBytes: null,
  createdAt: legacyScan.startedAt,
  modifiedAt: legacyScan.finishedAt
}
const unknown: FileEntry = {
  ...image,
  id: 'unknown',
  name: 'unreadable.txt',
  path: join(folder.path, 'unreadable.txt'),
  sizeBytes: null,
  modifiedAt: null
}

export const legacyEntries = { root, folder, image, unknown }

export function buildingFixture(id: string): BuildingScan {
  return {
    ...legacyScan,
    id,
    status: 'running',
    finishedAt: null,
    summary: { totalBytes: 0, fileCount: 0, directoryCount: 0, errorCount: 0 }
  }
}

export function seedV1Interrupted(sql: DatabaseSync, id = 'interrupted'): void {
  seedV1Scan(sql, buildingFixture(id), [
    { ...root, scanId: id, aggregatedSizeBytes: null },
    { ...folder, scanId: id, aggregatedSizeBytes: null },
    { ...image, scanId: id }
  ])
}
