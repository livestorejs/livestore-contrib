import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { writeArtifactCatalog } from './src/artifact-catalog-fs.ts'

const packageRoot = import.meta.dirname
const artifactDirectory = path.join(packageRoot, 'artifacts')

await writeArtifactCatalog(artifactDirectory)

export default defineConfig(({ command }) => ({
  cacheDir: path.join(packageRoot, `node_modules/.vite/scenario-viewer-${command}`),
  optimizeDeps: {
    entries: [
      path.join(packageRoot, 'src/viewer/index.html'),
      path.join(packageRoot, 'src/viewer/leader-state.worker.ts'),
    ],
  },
  plugins: [react()],
  root: path.join(packageRoot, 'src/viewer'),
  publicDir: artifactDirectory,
  build: {
    emptyOutDir: true,
    outDir: path.join(packageRoot, 'dist/viewer'),
  },
}))
