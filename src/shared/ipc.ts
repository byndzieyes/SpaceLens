import type {
  InsightsCategories,
  InsightsExtensionPage,
  InsightsExtensionRequest,
  InsightsObservations,
  InsightsRankingPage,
  InsightsRankingRequest,
  InsightsRequest,
  InsightsSizeDistribution,
  InsightsSummary
} from './insights'
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
  listScanHistory: (
    query: ScanHistoryQuery
  ) => Promise<ScannerIpcResult<ScanHistoryPage, ScanHistoryErrorCode>>
  getScanHistoryMetadata: (
    request: ScanHistoryMetadataRequest
  ) => Promise<ScannerIpcResult<ScanHistoryItem, ScanHistoryErrorCode>>
  getScanEntry: (request: ScanEntryRequest) => Promise<ScannerIpcResult<FileEntry>>
  listScanDirectory: (request: ScanDirectoryRequest) => Promise<ScannerIpcResult<ScanDirectoryPage>>
  getScanDirectoryTreemap: (
    request: ScanDirectoryTreemapRequest
  ) => Promise<ScannerIpcResult<ScanDirectoryTreemap>>
  getInsightsSummary: (request: InsightsRequest) => Promise<ScannerIpcResult<InsightsSummary>>
  getInsightsCategories: (request: InsightsRequest) => Promise<ScannerIpcResult<InsightsCategories>>
  getInsightsSizeDistribution: (
    request: InsightsRequest
  ) => Promise<ScannerIpcResult<InsightsSizeDistribution>>
  getInsightsObservations: (
    request: InsightsRequest
  ) => Promise<ScannerIpcResult<InsightsObservations>>
  listInsightsExtensions: (
    request: InsightsExtensionRequest
  ) => Promise<ScannerIpcResult<InsightsExtensionPage>>
  listInsightsLargestFiles: (
    request: InsightsRankingRequest
  ) => Promise<ScannerIpcResult<InsightsRankingPage>>
  listInsightsLargestDirectories: (
    request: InsightsRankingRequest
  ) => Promise<ScannerIpcResult<InsightsRankingPage>>
  cancelScan: (request: CancelScanRequest) => Promise<ScannerIpcResult<ScanAccepted>>
  onScanStateChanged: (callback: (snapshot: ScanStateSnapshot) => void) => () => void
}

export const IPC_CHANNELS = {
  getAppInfo: 'spacelens:get-app-info',
  selectScanDirectory: 'spacelens:select-scan-directory',
  startScan: 'spacelens:start-scan',
  getScanState: 'spacelens:get-scan-state',
  getScanSnapshot: 'spacelens:get-scan-snapshot',
  listScanHistory: 'spacelens:list-scan-history',
  getScanHistoryMetadata: 'spacelens:get-scan-history-metadata',
  getScanEntry: 'spacelens:get-scan-entry',
  listScanDirectory: 'spacelens:list-scan-directory',
  getScanDirectoryTreemap: 'spacelens:get-scan-directory-treemap',
  getInsightsSummary: 'spacelens:get-insights-summary',
  getInsightsCategories: 'spacelens:get-insights-categories',
  getInsightsSizeDistribution: 'spacelens:get-insights-size-distribution',
  getInsightsObservations: 'spacelens:get-insights-observations',
  listInsightsExtensions: 'spacelens:list-insights-extensions',
  listInsightsLargestFiles: 'spacelens:list-insights-largest-files',
  listInsightsLargestDirectories: 'spacelens:list-insights-largest-directories',
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

export type ScannerIpcResult<T, Code extends string = ScannerIpcErrorCode> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly error: { readonly code: Code; readonly message: string }
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
import type {
  ScanHistoryErrorCode,
  ScanHistoryItem,
  ScanHistoryMetadataRequest,
  ScanHistoryPage,
  ScanHistoryQuery
} from './history'
