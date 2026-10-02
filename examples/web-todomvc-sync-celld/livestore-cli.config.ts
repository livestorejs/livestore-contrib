import { makeWsSync } from '@livestore/sync-cf/client'

import { SyncPayload } from './src/livestore/schema.ts'

export { schema } from './src/livestore/schema.ts'

/**
 * MCP entrypoint for the web-todomvc-sync-celld example.
 */
export const syncBackend = makeWsSync({ url: process.env.LIVESTORE_SYNC_URL ?? 'ws://localhost:9876/sync' })
export const syncPayload = { authToken: process.env.LIVESTORE_SYNC_AUTH_TOKEN ?? 'insecure-token-change-me' }
export const syncPayloadSchema = SyncPayload
