import type { InsightsRequest, InsightsSummary } from './insights'
import type { FileEntry, RecentScanSummary, ScanSessionState } from './scan'
import type {
  ScanDirectoryPage,
  ScanDirectoryRequest,
  ScanDirectoryTreemap,
  ScanDirectoryTreemapRequest,
  ScanEntryRequest,
  ScanSnapshotAvailability,
  SnapshotAccessErrorCode
} from './snapshot'

export interface AppInfo {
  name: string
  version: string
  platform: string
}

export interface SpaceLensAPI {
  getAppInfo: () => Promise<AppInfo>
  selectScanDirectory: () => Promise<ScannerIpcResult<ScanDirectorySelection>>
  startScan: (request: StartScanRequest) => Promise<ScannerIpcResult<ScanAccepted>>
  getScanState: () => Promise<ScannerIpcResult<ScanStateSnapshot>>
  getScanSnapshot: () => Promise<ScannerIpcResult<ScanSnapshotAvailability>>
  getScanEntry: (request: ScanEntryRequest) => Promise<ScannerIpcResult<FileEntry>>
  listScanDirectory: (request: ScanDirectoryRequest) => Promise<ScannerIpcResult<ScanDirectoryPage>>
  getScanDirectoryTreemap: (
    request: ScanDirectoryTreemapRequest
  ) => Promise<ScannerIpcResult<ScanDirectoryTreemap>>
  getInsightsSummary: (request: InsightsRequest) => Promise<ScannerIpcResult<InsightsSummary>>
  cancelScan: (request: CancelScanRequest) => Promise<ScannerIpcResult<ScanAccepted>>
  onScanStateChanged: (callback: (snapshot: ScanStateSnapshot) => void) => () => void
}

export const IPC_CHANNELS = {
  getAppInfo: 'spacelens:get-app-info',
  selectScanDirectory: 'spacelens:select-scan-directory',
  startScan: 'spacelens:start-scan',
  getScanState: 'spacelens:get-scan-state',
  getScanSnapshot: 'spacelens:get-scan-snapshot',
  getScanEntry: 'spacelens:get-scan-entry',
  listScanDirectory: 'spacelens:list-scan-directory',
  getScanDirectoryTreemap: 'spacelens:get-scan-directory-treemap',
  getInsightsSummary: 'spacelens:get-insights-summary',
  cancelScan: 'spacelens:cancel-scan',
  scanStateChanged: 'spacelens:scan-state-changed',
  acknowledgeScanState: 'spacelens:acknowledge-scan-state'
} as const
export interface StartScanRequest {
  /** Use the exact canonical rootPath returned by selectScanDirectory(). */
  readonly rootPath: string
}

export type ScanDirectorySelection =
  { readonly cancelled: true } | { readonly cancelled: false; readonly rootPath: string }

export interface CancelScanRequest {
  readonly scanId: string
}

export type ScannerIpcErrorCode =
  | SnapshotAccessErrorCode
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'PATH_NOT_AUTHORIZED'
  | 'PICKER_BUSY'
  | 'PICKER_FAILED'
  | 'DIRECTORY_UNAVAILABLE'
  | 'SCAN_ACTIVE'
  | 'SCAN_MISMATCH'
  | 'NOT_RUNNING'
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR'

export type ScannerIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly error: { readonly code: ScannerIpcErrorCode; readonly message: string }
    }

/** Compare revisions when combining query responses with subscription updates. */
export interface ScanStateSnapshot {
  /** @deprecated SQLite publications always send null. */
  readonly snapshotUnavailable?: ScanSnapshotAvailability['unavailable']
  /** Latest confirmed SQLite publication, including results restored after recovery. */
  readonly latestCompleted?: RecentScanSummary | null
  /** Startup state of the publication summary, independent of active scanner progress. */
  readonly publicationStatus?: 'loading' | 'ready' | 'unavailable'
  readonly revision: number
  readonly state: ScanSessionState | null
}

export interface ScanAccepted {
  readonly scanId: string
}
