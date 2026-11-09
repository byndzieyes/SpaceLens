import type { ScanSessionState } from './scan'

export interface AppInfo {
  name: string
  version: string
  platform: string
}

export interface SpaceLensAPI {
  getAppInfo: () => Promise<AppInfo>
  startScan: (request: StartScanRequest) => Promise<ScannerIpcResult<ScanAccepted>>
  getScanState: () => Promise<ScannerIpcResult<ScanStateSnapshot>>
  cancelScan: (request: CancelScanRequest) => Promise<ScannerIpcResult<ScanAccepted>>
  onScanStateChanged: (callback: (snapshot: ScanStateSnapshot) => void) => () => void
}

export const IPC_CHANNELS = {
  getAppInfo: 'spacelens:get-app-info',
  startScan: 'spacelens:start-scan',
  getScanState: 'spacelens:get-scan-state',
  cancelScan: 'spacelens:cancel-scan',
  scanStateChanged: 'spacelens:scan-state-changed',
  acknowledgeScanState: 'spacelens:acknowledge-scan-state'
} as const
export interface StartScanRequest {
  readonly rootPath: string
}

export interface CancelScanRequest {
  readonly scanId: string
}

export type ScannerIpcErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'PATH_NOT_AUTHORIZED'
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
  readonly revision: number
  readonly state: ScanSessionState | null
}

export interface ScanAccepted {
  readonly scanId: string
}
