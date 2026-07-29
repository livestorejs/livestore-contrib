import type { LiveStoreSchema } from '@livestore/common/schema'
import React from 'react'

import type { DevtoolsApiSession } from './devtools-api.js'

export type SessionContext = {
  apiSession: DevtoolsApiSession
  appSchema: LiveStoreSchema
}
export const SessionContext = React.createContext<SessionContext>(null as any)

export const useSessionContext = () => React.useContext(SessionContext)
