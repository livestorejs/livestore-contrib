import '@livestore/adapter-web/worker-vite-dev-polyfill'
import { makeWorker } from '@livestore/adapter-web/worker'
import { Opfs } from '@livestore/utils/effect/browser'

import { schema } from './schema.js'

makeWorker({ schema })

declare global {
  // eslint-disable-next-line no-var
  var __debugOpfsUtils: typeof Opfs.debugUtils
}

// In case there's some debugging needed, we expose some OPFS utils
globalThis.__debugOpfsUtils = Opfs.debugUtils
