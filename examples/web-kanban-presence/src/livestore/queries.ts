import { queryDb } from '@livestore/livestore'

import { tables } from './schema.ts'

export const columns$ = queryDb(tables.columns.orderBy('position', 'asc'), { label: 'columns' })
export const cards$ = queryDb(tables.cards.orderBy('columnId', 'asc').orderBy('position', 'asc'), {
  label: 'cards',
})