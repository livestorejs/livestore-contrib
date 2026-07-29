import type * as LiveStore from '@livestore/livestore'
import type * as LiveStoreReact from '@livestore/react'
import React from 'react'

import type { schema } from './livestore/schema.js'

export const DevtoolsStoreContext = React.createContext<
  (LiveStore.Store<typeof schema> & LiveStoreReact.ReactApi) | undefined
>(undefined)

export const useDevtoolsStore = () => {
  const store = React.useContext(DevtoolsStoreContext)
  if (!store) {
    throw new Error('useDevtoolsStore must be used within DevtoolsStoreContext')
  }
  return store
}
