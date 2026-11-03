import type { SpaceLensAPI } from '../shared/ipc'

declare global {
  interface Window {
    readonly spaceLens: SpaceLensAPI
  }
}
