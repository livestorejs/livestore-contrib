import * as LiveStore from '@livestore/livestore'
import { Schema, Struct } from '@livestore/utils/effect'

export const NOT_REFRESHED_YET = Symbol.for('NOT_REFRESHED_YET')
export type NOT_REFRESHED_YET = typeof NOT_REFRESHED_YET

export const defaultColumnWidths: ColumnWidths = {
  index: 30,
  showSuper: 30,
  id: 70,
  _tag: 50,
  label: 350,
  previousResult: 300,
  updates: 60,
  sub: 150,
  super: 150,
  meta: 300,
}

export const Row = Schema.Struct({
  index: Schema.Finite,
  showSuper: Schema.Boolean,
  id: Schema.String,
  _tag: Schema.String,
  label: Schema.String,
  previousResult: Schema.Union([Schema.UniqueSymbol(NOT_REFRESHED_YET), Schema.String]),
  updates: Schema.Finite,
  sub: Schema.String,
  super: Schema.String,
  meta: Schema.String,
})

export type Row = typeof Row.Type

const RowKey = Schema.Literals(Struct.keys(Row.fields))

export const ColumnWidths = Schema.Record(RowKey, Schema.Finite)
export type ColumnWidths = typeof ColumnWidths.Type

const SortColumn = Schema.Struct({
  column: RowKey,
  direction: Schema.Literals(['asc', 'desc']),
})

export const stateSchemaAtomsTab = LiveStore.State.SQLite.clientDocument({
  name: '__livestore_devtools_AtomsTab',
  schema: Schema.Struct({
    columnWidths: ColumnWidths,
    sortColumn: SortColumn,
    showMap: Schema.Boolean,
    hideEffects: Schema.Boolean,
    minUpdates: Schema.Finite,
  }),
  default: {
    id: 'singleton',
    value: {
      columnWidths: defaultColumnWidths,
      sortColumn: { column: 'index', direction: 'asc' },
      showMap: false,
      hideEffects: true,
      minUpdates: 0,
    },
  },
})
