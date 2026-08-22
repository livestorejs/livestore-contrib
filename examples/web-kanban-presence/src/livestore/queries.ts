import { queryDb } from '@livestore/livestore'

import { tables } from './schema.ts'

export const columns$ = queryDb(tables.columns, { label: 'columns' })
export const cards$ = queryDb(tables.cards, { label: 'cards' })