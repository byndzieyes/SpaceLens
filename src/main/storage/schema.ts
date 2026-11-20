import type { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1

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

/** The caller holds an immediate transaction from the version check through schema validation. */
export function initializeSchema(connection: DatabaseSync): undefined {
  const version = connection.prepare('PRAGMA user_version').get()?.user_version
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported SQLite schema version ${version}. Expected ${SCHEMA_VERSION}.`)
  }

  const definitions = connection.prepare(
    "SELECT name, sql FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*'"
  )
  if (version === 0) {
    if (definitions.get()) throw new Error('Cannot initialize a non-empty unversioned database.')
    connection.exec(Object.values(schema).join(';\n'))
    connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  // These definitions are the version 1 format. SQLite preserves the canonical CREATE SQL.
  const stored = new Map(definitions.all().map(({ name, sql }) => [name, sql]))
  if (stored.size !== Object.keys(schema).length) {
    throw new Error('Invalid SQLite schema version 1. Unexpected or missing schema objects.')
  }
  for (const [name, sql] of Object.entries(schema)) {
    if (stored.get(name) !== sql) {
      throw new Error(`Invalid SQLite schema version 1. Unexpected definition for ${name}.`)
    }
  }
}
