import type { FileEntry, RecentScanSummary, ScanSessionState } from './scan'
import type {
  ScanDirectoryPage,
  ScanDirectoryRequest,
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
  /** Retention failure is separate from filesystem errors and does not invalidate statistics. */
  readonly snapshotUnavailable?: ScanSnapshotAvailability['unavailable']
  /** Latest settled completion in this application session; absent on older producers. */
  readonly latestCompleted?: RecentScanSummary | null
  readonly revision: number
  readonly state: ScanSessionState | null
}

export interface ScanAccepted {
  readonly scanId: string
}
