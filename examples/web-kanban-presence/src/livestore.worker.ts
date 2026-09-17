import { makeWorker } from '@livestore/adapter-web/worker'
import { makeWsSync } from '@livestore/sync-cf/client'

import { schema } from './livestore/schema.ts'

makeWorker({
  schema,
  sync: {
    // Use /sync path to avoid Assets binding intercepting root path requests
    backend: makeWsSync({ url: `${globalThis.location.origin}/sync` }),
    initialSyncOptions: { _tag: 'Blocking', timeout: 5000 },
  },
})