import { Schema } from '@livestore/utils/effect'
import { describe, expect, test } from 'vitest'

import { buildFieldsFromAst, validateArgs } from './schema.js'

describe('CreateEventModal schema fields', () => {
  const EventArgs = Schema.Struct({
    title: Schema.String,
    metadata: Schema.Struct({
      visibility: Schema.optional(Schema.Literals(['private', 'public'])),
      sentAt: Schema.DateFromMillis,
    }),
  })

  test('projects Effect 4 encoded and decoded ASTs into controls', () => {
    const fields = buildFieldsFromAst(EventArgs.ast)

    expect(fields.map(({ path, render, required }) => ({ path, render, required }))).toEqual([
      { path: ['title'], render: 'text', required: true },
      { path: ['metadata', 'visibility'], render: 'select', required: false },
      { path: ['metadata', 'sentAt'], render: 'datetime', required: true },
    ])
  })

  test('encodes decoded Date values and reports missing nested fields', () => {
    const fields = buildFieldsFromAst(EventArgs.ast)
    const valid = validateArgs({
      fields,
      argsState: {
        title: 'release',
        metadata: { sentAt: '2026-07-17T10:30' },
      },
      eventSchema: EventArgs,
    })

    expect(valid.ok).toBe(true)
    expect(valid.encoded).toEqual({
      title: 'release',
      metadata: { sentAt: new Date('2026-07-17T10:30').getTime() },
    })

    const invalid = validateArgs({
      fields,
      argsState: { title: 'release' },
      eventSchema: EventArgs,
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.fieldErrors['metadata.sentAt']).toContain('Required')
  })
})
