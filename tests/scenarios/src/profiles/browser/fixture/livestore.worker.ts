import { makeWorker } from '@livestore/adapter-web/worker'
import { makeWsSync } from '@livestore/sync-cf/client'
import type { Schema } from '@livestore/utils/effect'

import { getScenarioApplication } from '../../../corpus/applications/registry.ts'

declare const __SCENARIO_APPLICATION_ID__: string
declare const __SCENARIO_SYNC_URL__: string
declare const __SCENARIO_STORE_SUFFIX__: string
/** URI-encoded JSON `{ value }`, a plain string so production fixture builds can substitute it per run. */
declare const __SCENARIO_SYNC_PAYLOAD__: string
const syncPayload: Schema.Json | undefined = JSON.parse(decodeURIComponent(__SCENARIO_SYNC_PAYLOAD__)).value

const makeBackend = makeWsSync({ url: __SCENARIO_SYNC_URL__ })

makeWorker({
  schema: getScenarioApplication(__SCENARIO_APPLICATION_ID__).schema,
  sync: {
    backend: (args) =>
      makeBackend({
        ...args,
        storeId: `${args.storeId}-${__SCENARIO_STORE_SUFFIX__}`,
        payload: syncPayload,
      }),
    onSyncError: 'ignore',
  },
})
