/// <reference types="@cloudflare/workers-types" />

import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import { makeDurableObject, makeWorker } from '@livestore/sync-cf/cf-worker'

interface Env {
  SYNC_BACKEND_DO: CfTypes.DurableObjectNamespace
}

export class SyncBackendDO extends makeDurableObject() {}

export default makeWorker<Env>({
  syncBackendBinding: 'SYNC_BACKEND_DO',
  enableCORS: true,
})
