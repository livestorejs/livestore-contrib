import type { Devtools } from '@livestore/common'
import React from 'react'

import type { DevtoolsApi } from './devtools-api.js'

export type ApiContext = {
  api: DevtoolsApi
  selectedModeTag: Devtools.DevtoolsModeTag
}
export const ApiContext = React.createContext<ApiContext>(null as any)

export const useApiContext = () => React.useContext(ApiContext)
