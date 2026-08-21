import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const uiRoot = resolve(root, 'src/native-ui')

/** Build the Desktop-owned static native surfaces without network dependencies. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: uiRoot,
  base: './',
  resolve: { alias: { '@': resolve(root, 'src/native-ui') } },
  build: {
    outDir: resolve(root, 'lib/native-ui'),
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        recovery: resolve(uiRoot, 'recovery.html'),
        'profile-create': resolve(uiRoot, 'profile-create.html'),
      },
    },
  },
})
