import process from 'node:process'

import { livestoreDevtoolsPlugin } from '@livestore/devtools-vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** `celld dev` serves the sync worker; its default port is 9876. */
const syncOrigin = process.env.CELLD_URL ?? 'http://127.0.0.1:9876'

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 60_001,
    fs: { strict: false },
    // The app syncs through same-origin `/sync`, so Vite forwards HTTP and WebSocket traffic to celld.
    proxy: { '/sync': { target: syncOrigin, ws: true } },
  },
  worker: { format: 'es' },
  plugins: [react(), livestoreDevtoolsPlugin({ schemaPath: './src/livestore/schema.ts' })],
})
