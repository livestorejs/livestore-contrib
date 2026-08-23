import process from 'node:process'

import { cloudflare } from '@cloudflare/vite-plugin'
import { livestoreDevtoolsPlugin } from '@livestore/devtools-vite'
import { Effect, Logger, ManagedRuntime } from '@livestore/utils/effect'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

import { makeNodePresenceServerSelfContained } from '@livestore/sync-cf/presence/node-server'

/**
 * Starts the Node presence server in the same process as the Vite dev server,
 * so `pnpm dev` runs both the app and the ephemeral presence channel.
 */
const presenceServerPlugin = (): Plugin => ({
  name: 'kanban-presence-server',
  configureServer(server) {
    const runtime = ManagedRuntime.make(Logger.layer([Logger.consolePretty()]))
    const program = Effect.gen(function* () {
      const { port } = yield* makeNodePresenceServerSelfContained('kanban-demo', {
        host: '127.0.0.1',
        port: 8787,
      })
      yield* Effect.log(`Presence server on ws://127.0.0.1:${port}`)
      yield* Effect.never
    }).pipe(
      Effect.scoped,
      Effect.tapCause((cause) => Effect.logError('Presence server failed', cause)),
    )

    const fiber = runtime.runFork(program)
    server.httpServer?.once('close', () => runtime.runFork(Effect.interrupt(fiber)))
  },
})

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 60_004,
    fs: { strict: false },
  },
  worker: { format: 'es' },
  plugins: [cloudflare(), react(), presenceServerPlugin(), livestoreDevtoolsPlugin({ schemaPath: './src/livestore/schema.ts' })],
  optimizeDeps: {
    exclude: ['@livestore/wa-sqlite'],
  },
})