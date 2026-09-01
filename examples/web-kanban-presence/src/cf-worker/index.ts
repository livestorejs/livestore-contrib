import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import * as SyncBackend from '@livestore/sync-cf/cf-worker'

import { SyncPayload } from '../livestore/schema.ts'
import { presenceSchemas } from '../livestore/presence-schemas.ts'

export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log('onPush', message.batch, 'storeId:', context.storeId)
  },
  onPull: async (message, context) => {
    console.log('onPull', message, 'storeId:', context.storeId)
  },
  // Presence channels declared once here; every update is schema-decoded
  // before fan-out. Rooms default to `default` (this board).
  presence: {
    schemas: presenceSchemas,
    room: { memberIdleTtlMs: 15_000, sweepIntervalMs: 5_000 },
  },
}) {}

const validatePayload = (payload: { authToken: string } | undefined, context: { storeId: string }) => {
  if (payload?.authToken !== 'insecure-token-change-me') {
    throw new Error('Invalid auth token')
  }
}

export default {
  async fetch(request: CfTypes.Request, _env: SyncBackend.Env, ctx: CfTypes.ExecutionContext) {
    const searchParams = SyncBackend.matchSyncRequest(request)
    if (searchParams !== undefined) {
      return SyncBackend.handleSyncRequest({
        request,
        searchParams,
        ctx,
        syncBackendBinding: 'SYNC_BACKEND_DO',
        syncPayloadSchema: SyncPayload,
        validatePayload,
      })
    }

    return new Response('Not Found', { status: 404 })
  },
}