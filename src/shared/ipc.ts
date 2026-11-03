export interface AppInfo {
  name: string
  version: string
  platform: string
}

export interface SpaceLensAPI {
  getAppInfo: () => Promise<AppInfo>
}

export const IPC_CHANNELS = {
  getAppInfo: 'spacelens:get-app-info'
} as const
