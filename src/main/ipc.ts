import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS, type AppInfo } from '../shared/ipc'

export function registerAppInfoHandler(rendererUrl: string): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event, ...args: unknown[]): AppInfo => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== rendererUrl
    ) {
      throw new Error('App information is only available to the application renderer.')
    }

    if (args.length !== 0) {
      throw new Error('getAppInfo does not accept arguments.')
    }

    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform
    }
  })
}
