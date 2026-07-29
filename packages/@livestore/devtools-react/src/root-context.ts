import type { WebAdapterOptions } from '@livestore/adapter-web'
import type { Devtools } from '@livestore/common'
import type { LiveStoreSchema } from '@livestore/common/schema'
import type { Store } from '@livestore/livestore'
import { Schema } from '@livestore/utils/effect'
import React from 'react'

import type { DevtoolsApi } from './devtools-api.js'
import type { DevtoolsOptions } from './types.js'

export const MockMode = Schema.TaggedStruct('mock', {
  api: Schema.Any as Schema.Schema<DevtoolsApi>,
})

export type MockMode = typeof MockMode.Type

export type RootContext = {
  appSchemas: ReadonlyArray<LiveStoreSchema>
  mode: Devtools.DevtoolsMode | MockMode | undefined
  sharedWorker: WebAdapterOptions['sharedWorker']
  license: string | undefined
  options: DevtoolsOptions | undefined
  mountPath: string
  /**
   * Needed in some scenarios where it's safer for the app to reload instead of trying to recover somehow.
   *
   * TODO: let's get rid of this longer term.
   */
  triggerReload: () => void
  onBoot?: (store: Store) => void
}
export const RootContext = React.createContext<RootContext>(null as any)

export const useRootContext = () => React.useContext(RootContext)
