import { Devtools } from '@livestore/common'
import { State, SystemTables } from '@livestore/common/schema'
import { SessionIdSymbol } from '@livestore/livestore'
import { Schema } from '@livestore/utils/effect'

import { stateSchemaAtomsTab } from '../components/Tabs/Queries/DagNodes-common.js'

export const eventlogBrowserSchema = State.SQLite.clientDocument({
  name: '__livestore_devtools_EventlogBrowser',
  schema: Schema.Struct({
    autoRefresh: Schema.Boolean,
    showAllColumns: Schema.Boolean,
    selectedEventTypes: Schema.Array(Schema.Literals(['server', 'client'])),
  }),
  default: {
    id: 'singleton',
    value: { autoRefresh: true, showAllColumns: false, selectedEventTypes: ['server', 'client'] },
  },
})

const orderByDirection = Schema.Literals(['asc', 'desc'])

export const dataBrowserDynamicSchema = State.SQLite.clientDocument({
  name: '__livestore_devtools_DataBrowserTab',
  schema: Schema.Struct({
    searchKey: Schema.String,
    orderByColumn: Schema.String,
    orderByDirection: orderByDirection,
    columnWidths: Schema.Record(Schema.String, Schema.Finite),
  }),
  default: {
    value: { searchKey: '', orderByColumn: '', orderByDirection: 'asc', columnWidths: {} },
  },
})

export const dataBrowserStaticSchema = State.SQLite.clientDocument({
  name: '__livestore_devtools_DataBrowserTab_singleton',
  schema: Schema.Struct({
    activeTableName: Schema.String,
    livestoreInternalsExpanded: Schema.Boolean,
  }),
  default: {
    id: SessionIdSymbol,
    value: { activeTableName: SystemTables.SCHEMA_META_TABLE, livestoreInternalsExpanded: false },
  },
})

export const stateSchemaLiveQueriesTab = State.SQLite.clientDocument({
  name: '__livestore_devtools_LiveQueriesTab',
  schema: Schema.Struct({
    autoRefresh: Schema.Boolean,
  }),
  default: { id: SessionIdSymbol, value: { autoRefresh: true } },
})

export const stateSchemaTabsContainer = State.SQLite.clientDocument({
  name: '__livestore_devtools_TabsContainer',
  schema: Schema.Struct({
    tabIndex: Schema.Finite,
    showMeters: Schema.Boolean,
  }),
  default: { id: SessionIdSymbol, value: { tabIndex: 0, showMeters: true } },
})

export const stateSchemaQueriesTab = State.SQLite.clientDocument({
  name: '__livestore_devtools_QueriesTab',
  schema: Schema.Struct({
    tabIndex: Schema.Finite,
  }),
  default: { id: SessionIdSymbol, value: { tabIndex: 0 } },
})

export const networkState = State.SQLite.clientDocument({
  name: '__livestore_devtools_NetworkState',
  schema: Schema.Struct({
    status: Devtools.NetworkStatus,
  }),
  default: {
    value: { status: { isConnected: false, timestampMs: 0, devtools: { latchClosed: false } } },
  },
})

export const sqlitePlaygroundState = State.SQLite.clientDocument({
  name: '__livestore_devtools_SqlitePlaygroundState',
  schema: Schema.Struct({
    query: Schema.String,
  }),
  default: { id: 'singleton', value: { query: '' } },
})

export const tables = {
  eventlogBrowserSchema,
  dataBrowserDynamicSchema,
  dataBrowserStaticSchema,
  stateSchemaAtomsTab,
  stateSchemaLiveQueriesTab,
  stateSchemaQueriesTab,
  stateSchemaTabsContainer,
  networkState,
  sqlitePlaygroundState,
}
