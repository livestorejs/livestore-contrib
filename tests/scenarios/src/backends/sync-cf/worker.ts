/// <reference types="@cloudflare/workers-types" />

import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import { makeDurableObject, makeWorker, type SyncBackendRpcInterface } from '@livestore/sync-cf/cf-worker'
import { Schema } from '@livestore/utils/effect'

const ScenarioSyncPayload = Schema.TaggedStruct('scenario-cloud-auth', {
  token: Schema.String,
})
type ScenarioSyncPayload = typeof ScenarioSyncPayload.Type

interface ScenarioSyncBackendRpc extends SyncBackendRpcInterface {
  clearScenarioStorage(): Promise<void>
}

interface Env {
  SYNC_BACKEND_DO: CfTypes.DurableObjectNamespace<ScenarioSyncBackendRpc>
  SCENARIO_SYNC_TOKEN?: string
  SCENARIO_BACKEND_REVISION?: string
}

export class SyncBackendDO extends makeDurableObject() {
  private readonly scenarioState: CfTypes.DurableObjectState

  constructor(state: CfTypes.DurableObjectState, env: Env) {
    super(state, env)
    this.scenarioState = state
  }

  async clearScenarioStorage(): Promise<void> {
    await this.scenarioState.storage.deleteAll()
  }
}

export default {
  async fetch(request: CfTypes.Request, env: Env, ctx: CfTypes.ExecutionContext): Promise<CfTypes.Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/__scenario/health') {
      return Response.json({
        service: 'livestore-scenario-sync-cf',
        backendRevision: env.SCENARIO_BACKEND_REVISION ?? 'unknown',
        tokenFingerprint:
          env.SCENARIO_SYNC_TOKEN === undefined ? null : await tokenFingerprint(env.SCENARIO_SYNC_TOKEN),
      }) as unknown as CfTypes.Response
    }

    if (request.method === 'POST' && url.pathname === '/__scenario/cleanup') {
      if (
        env.SCENARIO_SYNC_TOKEN === undefined ||
        request.headers.get('x-scenario-sync-token') !== env.SCENARIO_SYNC_TOKEN
      ) {
        return new Response('Unauthorized', { status: 401 }) as unknown as CfTypes.Response
      }

      const input = (await request.json()) as { storeIds?: unknown }
      if (
        Array.isArray(input.storeIds) === false ||
        input.storeIds.some((storeId) => typeof storeId !== 'string' || storeId.length === 0) === true
      ) {
        return new Response('Invalid storeIds', { status: 400 }) as unknown as CfTypes.Response
      }

      await Promise.all(
        input.storeIds.map((storeId) =>
          env.SYNC_BACKEND_DO.get(env.SYNC_BACKEND_DO.idFromName(storeId)).clearScenarioStorage(),
        ),
      )
      return Response.json({ cleared: input.storeIds.length }) as unknown as CfTypes.Response
    }

    if (env.SCENARIO_SYNC_TOKEN === undefined) {
      return makeWorker<Env, ScenarioSyncBackendRpc>({
        syncBackendBinding: 'SYNC_BACKEND_DO',
        enableCORS: true,
      }).fetch(request, env, ctx)
    }

    return makeWorker<Env, ScenarioSyncBackendRpc, ScenarioSyncPayload>({
      syncBackendBinding: 'SYNC_BACKEND_DO',
      syncPayloadSchema: ScenarioSyncPayload,
      validatePayload: (payload) => {
        if (payload.token !== env.SCENARIO_SYNC_TOKEN) throw new Error('Unauthorized scenario sync connection')
      },
      enableCORS: true,
    }).fetch(request, env, ctx)
  },
}

const tokenFingerprint = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
