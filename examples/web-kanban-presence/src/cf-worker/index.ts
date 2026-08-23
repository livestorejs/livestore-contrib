import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import * as SyncBackend from '@livestore/sync-cf/cf-worker'
import { PresenceDurableObject } from '@livestore/sync-cf/cf-worker'

import { SyncPayload } from '../livestore/schema.ts'

export { PresenceDurableObject }

export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log('onPush', message.batch, 'storeId:', context.storeId)
  },
  onPull: async (message, context) => {
    console.log('onPull', message, 'storeId:', context.storeId)
  },
}) {}

const validatePayload = (payload: { authToken: string } | undefined, context: { storeId: string }) => {
  if (payload?.authToken !== 'insecure-token-change-me') {
    throw new Error('Invalid auth token')
  }
}

export interface Env extends SyncBackend.Env {
  PRESENCE_DO: DurableObjectNamespace<PresenceDurableObject>
}

export default {
  async fetch(request: CfTypes.Request, env: Env, ctx: CfTypes.ExecutionContext) {
    // Presence channel: upgrade WebSocket connections to the presence DO.
    const url = new URL(request.url)
    if (url.pathname === '/presence') {
      const storeId = url.searchParams.get('storeId') ?? 'kanban-demo'
      const doId = env.PRESENCE_DO.idFromName(storeId)
      return env.PRESENCE_DO.get(doId).fetch(request as never)
    }

    // Durable board: the standard sync-cf backend.
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