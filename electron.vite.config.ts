import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    const { REACT_DEVTOOLS_PATH } = loadEnv(mode, process.cwd(), 'REACT_DEVTOOLS_PATH')
    if (REACT_DEVTOOLS_PATH !== undefined) {
      process.env['REACT_DEVTOOLS_PATH'] = REACT_DEVTOOLS_PATH
    }
  }

  return {
    main: {
      build: {
        rolldownOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            scannerWorkerRunner: resolve('src/main/scanner/workerRunner.ts'),
            scanSessionManager: resolve('src/main/scanner/sessionManager.ts')
          }
        }
      }
    },
    preload: {},
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react(), tailwindcss()]
    }
  }
})
