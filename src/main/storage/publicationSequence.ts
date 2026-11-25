import type { DatabaseSync } from 'node:sqlite'

const MAX_SQLITE_INTEGER = (1n << 63n) - 1n

/** The counter is a high-water mark, including publications whose scans were deleted. */
export function readPublicationCounter(connection: DatabaseSync): bigint {
  const statement = connection.prepare(`
    SELECT id, last_sequence,
           (SELECT MAX(publication_sequence) FROM scans WHERE status = 'completed') AS latest,
           EXISTS (
             SELECT 1 FROM scans
             WHERE (status = 'completed') <> (publication_sequence IS NOT NULL)
                OR publication_sequence <= 0
           ) AS invalid_sequence
    FROM scan_publication_counter LIMIT 2
  `)
  statement.setReadBigInts(true)
  const [counter, extra] = statement.all()
  if (
    !counter ||
    extra ||
    counter.id !== 1n ||
    typeof counter.last_sequence !== 'bigint' ||
    counter.last_sequence < 0n ||
    counter.last_sequence > MAX_SQLITE_INTEGER
  ) {
    throw new Error('Invalid publication sequence counter.')
  }
  if (counter.invalid_sequence !== 0n) throw new Error('Invalid scan publication sequence.')
  if (
    counter.latest !== null &&
    (typeof counter.latest !== 'bigint' || counter.latest > counter.last_sequence)
  ) {
    throw new Error('The publication sequence counter is behind a completed scan.')
  }
  return counter.last_sequence
}

/** Read the next sequence while holding the publication transaction. */
export function nextPublicationSequence(connection: DatabaseSync): bigint {
  const last = readPublicationCounter(connection)
  if (last === MAX_SQLITE_INTEGER) throw new RangeError('The publication sequence is exhausted.')
  return last + 1n
}

export function recordPublicationSequence(connection: DatabaseSync, sequence: bigint): void {
  const result = connection
    .prepare(
      'UPDATE scan_publication_counter SET last_sequence = ? WHERE id = 1 AND last_sequence = ?'
    )
    .run(sequence, sequence - 1n)
  if (result.changes !== 1) throw new Error('Could not advance the publication sequence counter.')
}
