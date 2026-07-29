import type * as LiveStoreReact from '@livestore/react'
import React from 'react'

import { defaultColumnWidths } from '../../components/Tabs/Queries/DagNodes-common.js'
import type { State } from '../../components/Tabs/Queries/DagNodes.js'

export const useTestingState = () => {
  const initialState: State = {
    columnWidths: defaultColumnWidths,
    sortColumn: { column: 'index', direction: 'asc' },
    // showMap: true,
    showMap: false,
    hideEffects: false,
    minUpdates: 0,
  }

  const [state, setStateInternal] = React.useState(initialState)

  const setState = React.useCallback(
    (updater: Partial<State> | ((prev: State) => State | Partial<State>)) => {
      setStateInternal((prevState) => {
        if (typeof updater === 'function') {
          const result = updater(prevState)
          return typeof result === 'object' && result !== null
            ? { ...prevState, ...result }
            : (result as State)
        } else {
          return { ...prevState, ...updater }
        }
      })
    },
    [],
  )

  return [
    state,
    setState as LiveStoreReact.Dispatch<LiveStoreReact.SetStateActionPartial<State>>,
  ] as const
}
