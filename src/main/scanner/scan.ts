import { aggregateDirectorySizes } from './aggregate'
import { summarizeScanEvents, type ScanOutputEvent } from './summary'
import { traverseDirectoryEvents } from './traverse'

/** Stream discoveries, finalized directories, errors, then a final summary; stores no entries. */
export async function* scanDirectory(
  rootPath: string,
  scanId: string,
  signal?: AbortSignal
): AsyncGenerator<ScanOutputEvent, void, void> {
  yield* summarizeScanEvents(
    aggregateDirectorySizes(traverseDirectoryEvents(rootPath, scanId, signal)),
    scanId
  )
}
