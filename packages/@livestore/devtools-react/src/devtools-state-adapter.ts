import {
  makeInMemoryAdapter as defaultMakeInMemoryAdapter,
  makeSingleTabAdapter as defaultMakeSingleTabAdapter,
  type SingleTabAdapterOptions,
} from '@livestore/adapter-web'
import type { Adapter } from '@livestore/common'
import { liveStoreVersion, type Devtools } from '@livestore/common'

import type { DevtoolsOptions } from './types.ts'

type AdapterFactories = {
  makeInMemoryAdapter: typeof defaultMakeInMemoryAdapter
  makeSingleTabAdapter: typeof defaultMakeSingleTabAdapter
}

const defaultAdapterFactories: AdapterFactories = {
  makeInMemoryAdapter: defaultMakeInMemoryAdapter,
  makeSingleTabAdapter: defaultMakeSingleTabAdapter,
}

export const devtoolsStateStorageDirectory = (storeId: string): string =>
  `livestore-devtools_${liveStoreVersion}_${storeId}`

export const makeDevtoolsStateAdapter = ({
  mode,
  storeId,
  worker,
  options,
  adapterFactories = defaultAdapterFactories,
}: {
  mode: Devtools.DevtoolsMode | 'mock'
  storeId: string
  worker: SingleTabAdapterOptions['worker']
  options: DevtoolsOptions | undefined
  adapterFactories?: AdapterFactories
}): Adapter =>
  mode === 'mock'
    ? adapterFactories.makeInMemoryAdapter({})
    : adapterFactories.makeSingleTabAdapter({
        storage: {
          type: 'opfs',
          directory: devtoolsStateStorageDirectory(storeId),
        },
        worker,
        ...(options?.resetPersistence !== undefined
          ? { resetPersistence: options.resetPersistence }
          : {}),
      })
