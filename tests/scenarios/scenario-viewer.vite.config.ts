import path from 'node:path'

import { defineConfig } from 'vite'

const packageRoot = import.meta.dirname

export default defineConfig({
  root: path.join(packageRoot, 'src/viewer'),
  publicDir: path.join(packageRoot, 'artifacts'),
  build: {
    emptyOutDir: true,
    outDir: path.join(packageRoot, 'dist/viewer'),
  },
})
