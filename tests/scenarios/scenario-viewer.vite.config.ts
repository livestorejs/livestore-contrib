import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { writeArtifactCatalog } from './src/artifact-catalog-fs.ts'

const packageRoot = import.meta.dirname
const artifactDirectory = path.join(packageRoot, 'artifacts')

await writeArtifactCatalog(artifactDirectory)

export default defineConfig({
  plugins: [react()],
  root: path.join(packageRoot, 'src/viewer'),
  publicDir: artifactDirectory,
  build: {
    emptyOutDir: true,
    outDir: path.join(packageRoot, 'dist/viewer'),
  },
})
