/** Local cancellation outcome, distinct from filesystem failures and completion. */
export class ScanCancelledError extends Error {
  readonly code = 'SCAN_CANCELLED'

  constructor() {
    super('Scan cancelled.')
    this.name = 'ScanCancelledError'
  }
}

/** Allow cooperative handle cleanup before terminating an unresponsive worker. */
export const SCANNER_CANCEL_TIMEOUT_MS = 2_000
