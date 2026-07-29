import { makeSchema, State } from '@livestore/common/schema'

import { tables } from './tables.js'

export const events = {
  dataBrowserStaticSchemaSet: tables.dataBrowserStaticSchema.set,
  eventlogBrowserSchemaSet: tables.eventlogBrowserSchema.set,
  sqlitePlaygroundStateSet: tables.sqlitePlaygroundState.set,
  stateSchemaLiveQueriesTabSet: tables.stateSchemaLiveQueriesTab.set,
  stateSchemaTabsContainerSet: tables.stateSchemaTabsContainer.set,
  stateSchemaQueriesTabSet: tables.stateSchemaQueriesTab.set,
  stateSchemaAtomsTabSet: tables.stateSchemaAtomsTab.set,
}

const materializers = State.SQLite.materializers(events, {})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })
