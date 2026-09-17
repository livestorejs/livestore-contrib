import { makeWorker } from '@livestore/adapter-web/worker'
import { makeWsSync } from '@livestore/sync-cf/client'
import type { Schema } from '@livestore/utils/effect'

import { todoSchema } from '../../../corpus/applications/todo.ts'

declare const __SCENARIO_SYNC_URL__: string
declare const __SCENARIO_STORE_SUFFIX__: string
declare const __SCENARIO_SYNC_PAYLOAD__: Schema.Json | undefined

const makeBackend = makeWsSync({ url: __SCENARIO_SYNC_URL__ })

makeWorker({
  schema: todoSchema,
  sync: {
    backend: (args) =>
      makeBackend({
        ...args,
        storeId: `${args.storeId}-${__SCENARIO_STORE_SUFFIX__}`,
        payload: __SCENARIO_SYNC_PAYLOAD__,
      }),
    onSyncError: 'ignore',
  },
})
