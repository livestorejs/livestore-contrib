import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const packageRoot = import.meta.dirname

export default defineConfig({
  plugins: [react()],
  root: path.join(packageRoot, 'src/viewer'),
  publicDir: path.join(packageRoot, 'artifacts'),
  build: {
    emptyOutDir: true,
    outDir: path.join(packageRoot, 'dist/viewer'),
  },
})
