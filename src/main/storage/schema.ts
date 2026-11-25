import type { DatabaseSync } from 'node:sqlite'
import { readPublicationCounter } from './publicationSequence'

const SCHEMA_VERSION = 2

const schemaV1 = {
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

const sequenceColumn = 'publication_sequence INTEGER CHECK (publication_sequence > 0)'
const requireCompletedSequence = `WHEN (NEW.status = 'completed') <> (NEW.publication_sequence IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'Only completed scans must have a publication sequence'); END`

const publicationSchema = {
  scan_publication_counter: `CREATE TABLE scan_publication_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
  ) STRICT`,
  scans_by_publication_sequence: `CREATE UNIQUE INDEX scans_by_publication_sequence
    ON scans(publication_sequence) WHERE status = 'completed'`,
  scans_one_running: `CREATE UNIQUE INDEX scans_one_running
    ON scans(status) WHERE status = 'running'`,
  scans_require_sequence_on_insert: `CREATE TRIGGER scans_require_sequence_on_insert
    BEFORE INSERT ON scans ${requireCompletedSequence}`,
  scans_require_sequence_on_update: `CREATE TRIGGER scans_require_sequence_on_update
    BEFORE UPDATE OF status, publication_sequence ON scans ${requireCompletedSequence}`
}

const schemaV2 = {
  ...schemaV1,
  // SQLite inserts the new column here, before the existing table-level constraint.
  scans: schemaV1.scans.replace(
    ',\n    CONSTRAINT scan_finish_time',
    `, ${sequenceColumn},\n    CONSTRAINT scan_finish_time`
  ),
  ...publicationSchema
}

function validateSchema(
  stored: ReadonlyMap<unknown, unknown>,
  schema: Record<string, string>,
  version: number
): void {
  if (stored.size !== Object.keys(schema).length) {
    throw new Error(
      `Invalid SQLite schema version ${version}. Unexpected or missing schema objects.`
    )
  }
  for (const [name, sql] of Object.entries(schema)) {
    if (stored.get(name) !== sql) {
      throw new Error(
        `Invalid SQLite schema version ${version}. Unexpected definition for ${name}.`
      )
    }
  }
}

/** The caller holds an immediate transaction across validation, legacy recovery, and migration. */
export function initializeSchema(
  connection: DatabaseSync,
  recoverLegacy: () => string | null
): undefined {
  const version = connection.prepare('PRAGMA user_version').get()?.user_version
  if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported SQLite schema version ${version}. Expected ${SCHEMA_VERSION}.`)
  }

  const definitions = connection.prepare(
    "SELECT name, sql FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*'"
  )
  const readDefinitions = (): Map<unknown, unknown> =>
    new Map(definitions.all().map(({ name, sql }) => [name, sql]))

  if (version === 0) {
    if (definitions.get()) throw new Error('Cannot initialize a non-empty unversioned database.')
    connection.exec(Object.values(schemaV2).join(';\n'))
    connection.exec('INSERT INTO scan_publication_counter (id, last_sequence) VALUES (1, 0)')
  } else if (version === 1) {
    validateSchema(readDefinitions(), schemaV1, version)
    const publishedId = recoverLegacy()
    connection.exec(`ALTER TABLE scans ADD COLUMN ${sequenceColumn}`)
    if (publishedId !== null) {
      const result = connection
        .prepare("UPDATE scans SET publication_sequence = 1 WHERE id = ? AND status = 'completed'")
        .run(publishedId)
      if (result.changes !== 1) throw new Error('Could not assign the legacy publication sequence.')
    }
    connection.exec(Object.values(publicationSchema).join(';\n'))
    connection
      .prepare('INSERT INTO scan_publication_counter (id, last_sequence) VALUES (1, ?)')
      .run(publishedId === null ? 0n : 1n)
  }

  validateSchema(readDefinitions(), schemaV2, SCHEMA_VERSION)
  readPublicationCounter(connection)
  if (version !== SCHEMA_VERSION) connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
