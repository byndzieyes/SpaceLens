import { app, BrowserWindow, session } from 'electron'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerAppInfoHandler } from './ipc'
import { ScanSessionManager } from './scanner/sessionManager'
import { registerScannerIpc, registerScannerShutdown } from './scannerIpc'

const scanManager = new ScanSessionManager()
let scannerIpc: ReturnType<typeof registerScannerIpc> | undefined
registerScannerShutdown(() => (scannerIpc ? scannerIpc.dispose() : scanManager.dispose()))

const rendererUrl =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).href
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    title: 'SpaceLens',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  scannerIpc?.attachRenderer(mainWindow.webContents)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  mainWindow.loadURL(rendererUrl)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.spacelens.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerAppInfoHandler(rendererUrl)
  // Only native directory selection can grant this renderer permission to scan a root.
  scannerIpc = registerScannerIpc(scanManager, rendererUrl)

  if (!app.isPackaged && process.env['NODE_ENV'] === 'development') {
    const extensionPath = process.env['REACT_DEVTOOLS_PATH']?.trim()

    if (extensionPath) {
      try {
        await session.defaultSession.extensions.loadExtension(resolve(extensionPath), {
          allowFileAccess: true
        })
      } catch (error) {
        console.warn('[React DevTools] Could not load extension; continuing startup.', error)
      }
    } else {
      console.info('[React DevTools] Set REACT_DEVTOOLS_PATH to enable the extension.')
    }
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
