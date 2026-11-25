import type { ScanHistoryItem } from './history'
import type { ScanSnapshot, ScanSnapshotAvailability } from './snapshot'

export type SnapshotView = 'explorer' | 'insights'

export type SnapshotSelection =
  { readonly mode: 'follow-latest' } | { readonly mode: 'explicit'; readonly scanId: string }

export const followLatest: SnapshotSelection = { mode: 'follow-latest' }

export interface SnapshotSelectionRequest {
  readonly view: SnapshotView
  readonly selection: SnapshotSelection
}

export type SnapshotSelectionResolution =
  | { readonly mode: 'follow-latest'; readonly availability: ScanSnapshotAvailability }
  | { readonly mode: 'explicit'; readonly metadata: ScanHistoryItem }

export interface PreparedSnapshotSelection {
  readonly ticket: string
  readonly resolution: SnapshotSelectionResolution
}

export interface SnapshotSelectionAdoption extends SnapshotViewRequest {
  readonly ticket: string
}

/** Only explicit Explorer adoption returns the validated snapshot. */
export type SnapshotSelectionAdoptionResult = ScanSnapshot | null

export interface SnapshotViewRequest {
  readonly view: SnapshotView
}
