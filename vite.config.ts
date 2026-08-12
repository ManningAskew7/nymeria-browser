import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const copyPublicFiles = () => ({
  name: 'copy-public-files',
  closeBundle() {
    const files = ['manifest.json', 'icon-16.png', 'icon-48.png', 'icon-128.png']
    for (const file of files) {
      try {
        copyFileSync(
          resolve(__dirname, 'public', file),
          resolve(__dirname, 'dist', file),
        )
      } catch {
        console.warn(`Warning: ${file} not found in public/`)
      }
    }
  },
})

export default defineConfig({
  plugins: [react(), copyPublicFiles()],
  build: {
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        background: 'src/background/index.ts',
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.facadeModuleId?.includes('/background/')) {
            return 'background.js'
          }
          return 'assets/[name]-[hash].js'
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        format: 'es',
      },
    },
    // Chrome refuses a modulepreload link from an extension page as a
    // "cross-world extension resource mismatch" and logs it on every popup
    // open. The module still loads through its import, so the preload buys
    // nothing here and only produces noise the user has to learn to ignore.
    modulePreload: false,
    target: 'chrome91',
    minify: false,
  },
})
