/**
 * Dumps TS storage fingerprints (`fingerprint(tableAst)`) and event schema hashes (`Schema.hash`) for schemas the
 * Rust DSL can express, into `crates/livestore-schema/tests/fixtures/schema_hashes.json`. The Rust test
 * `schema_hash_parity.rs` builds the same schemas and must produce the same values.
 *
 * Run from the repo root: `bun rust/scripts/gen-schema-hash-fixtures.ts`
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { Schema, SchemaAST, SchemaRepresentation } from '../../repos/livestore/packages/@livestore/utils/src/effect/mod.ts'

import { SessionIdSymbol } from '../../repos/livestore/packages/@livestore/common/src/index.ts'
import { fingerprint } from '../../repos/livestore/packages/@livestore/common/src/schema/state/sqlite/db-schema/ast/fingerprint.ts'
import { State } from '../../repos/livestore/packages/@livestore/common/src/schema/mod.ts'
import { SqliteDsl } from '../../repos/livestore/packages/@livestore/common/src/schema/state/sqlite/db-schema/mod.ts'

const { SQLite } = State
class Person extends Schema.Class<Person>('Person')({ name: Schema.String, age: Schema.Int }) {}

/** Value schemas shared by JSON columns, schema-derived tables and event args. */
const values: Record<string, Schema.Top> = {
  struct: Schema.Struct({ a: Schema.String, n: Schema.Number }),
  nested: Schema.Struct({
    outer: Schema.Struct({ inner: Schema.Struct({ x: Schema.Int }) }),
    list: Schema.Array(Schema.Struct({ y: Schema.String })),
  }),
  literals: Schema.Struct({
    one: Schema.Literal('x'),
    many: Schema.Literals(['all', 'active', 'completed']),
    num: Schema.Literal(1),
    flag: Schema.Literal(true),
  }),
  unions: Schema.Struct({
    mixed: Schema.Union([Schema.String, Schema.Number, Schema.Struct({ a: Schema.Boolean })]),
    nullable: Schema.NullOr(Schema.String),
    undef: Schema.UndefinedOr(Schema.Number),
  }),
  dates: Schema.Struct({ iso: Schema.DateFromString, millis: Schema.DateFromMillis, maybe: Schema.NullOr(Schema.DateFromString) }),
  optional: Schema.Struct({ a: Schema.optional(Schema.String), b: Schema.optionalKey(Schema.Number) }),
  checks: Schema.Struct({
    nonEmpty: Schema.NonEmptyString,
    min3: Schema.String.check(Schema.isMinLength(3)),
    int: Schema.Int,
    finite: Schema.Finite,
    between: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
    gte: Schema.Number.check(Schema.isGreaterThanOrEqualTo(3)),
    pattern: Schema.String.check(Schema.isPattern(/^[A-Z]+$/)),
    custom: Schema.String.check(Schema.makeFilter((s) => s.length > 1)),
    trim: Schema.Trim,
    after: Schema.Date.check(Schema.isGreaterThanDate(new Date(0))),
  }),
  collections: Schema.Struct({
    record: Schema.Record(Schema.String, Schema.Number),
    tuple: Schema.Tuple([Schema.String, Schema.Number]),
    strings: Schema.Array(Schema.String),
  }),
  codecs: Schema.Struct({
    bits: Schema.BooleanFromBit,
    bytes: Schema.Uint8ArrayFromBase64,
    finite: Schema.FiniteFromString,
    person: Person,
  }),
  ids: Schema.Struct({ uuid: Schema.String.check(Schema.isUUID()), ulid: Schema.String.check(Schema.isULID()) }),
  scalars: Schema.Struct({ s: Schema.String, b: Schema.Boolean, u: Schema.Unknown, a: Schema.Any, z: Schema.Null }),
  array: Schema.Array(Schema.String),
  string: Schema.String,
  any: Schema.Any,
}

const jsonTable = (name: string, schema: Schema.Top | undefined, nullable = false) =>
  SQLite.table({ name, columns: { id: SQLite.text({ primaryKey: true }), value: SQLite.json({ schema, nullable } as any) } })

const tables: Record<string, any> = {}
for (const [key, schema] of Object.entries(values)) {
  tables[`json_${key}`] = jsonTable(key, schema)
  tables[`json_nullable_${key}`] = jsonTable(key, schema, true)
}
tables.json_default = SQLite.table({ name: 'docs', columns: { id: SQLite.text({ primaryKey: true }), value: SQLite.json() } })
tables.json_default_nullable = SQLite.table({ name: 'docs', columns: { id: SQLite.text({ primaryKey: true }), value: SQLite.json({ nullable: true }) } })
tables.json_with_default = SQLite.table({
  name: 'docs',
  columns: { id: SQLite.text({ primaryKey: true }), value: SQLite.json({ schema: values.struct!, default: { a: 'x', n: 1 } } as any) },
})
tables.text_json_codec = SQLite.table({
  name: 'docs',
  columns: { id: SQLite.text({ primaryKey: true }), value: SQLite.text({ schema: Schema.fromJsonString(values.struct!) } as any) },
})
tables.physical = SQLite.table({
  name: 'todos',
  columns: {
    id: SQLite.text({ primaryKey: true }),
    text: SQLite.text({ default: '' }),
    completed: SQLite.boolean({ default: false }),
    deletedAt: SQLite.integer({ nullable: true, schema: Schema.DateFromMillis }),
    at: SQLite.datetime({ nullable: true }),
    atMs: SqliteDsl.datetimeInteger(),
    blob: SQLite.blob({ nullable: true }),
    real: SQLite.real({ default: 1.5 }),
  },
  indexes: [{ name: 'todos_by_text', columns: ['text'] }],
})
tables.derived = SQLite.table({
  name: 'derived',
  schema: Schema.Struct({
    id: Schema.String.pipe(SQLite.withPrimaryKey),
    title: Schema.NonEmptyString,
    tags: Schema.Array(Schema.String),
    meta: Schema.optional(Schema.Struct({ nested: Schema.Struct({ n: Schema.Int }) })),
    status: Schema.Literals(['a', 'b']),
    at: Schema.DateFromString,
    maybe: Schema.NullOr(Schema.Struct({ x: Schema.Number })),
  }),
})
const uiState = SQLite.clientDocument({
  name: 'uiState',
  schema: Schema.Struct({ newTodoText: Schema.String, filter: Schema.Literals(['all', 'active', 'completed']) }),
  default: { id: SessionIdSymbol, value: { newTodoText: '', filter: 'all' } },
})
const settings = SQLite.clientDocument({
  name: 'settings',
  schema: Schema.Struct({ theme: Schema.NullOr(Schema.String), sizes: Schema.Array(Schema.Int), since: Schema.DateFromString }),
  default: { id: 'global', value: { theme: null, sizes: [], since: new Date(0) } },
  partialSet: false,
})
const counter = SQLite.clientDocument({ name: 'counter', schema: Schema.Number, default: { value: 0 } })
tables.client_document_ui_state = uiState
tables.client_document_settings = settings
tables.client_document_counter = counter

const events: Record<string, Schema.Top> = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v]))
events.todoCreated = Schema.Struct({ id: Schema.String, text: Schema.String })
events.todoId = Schema.Struct({ id: Schema.String })
events.todoDeleted = Schema.Struct({ id: Schema.String, deletedAt: Schema.DateFromString })
events.titled = Schema.Struct({ id: Schema.String }).annotate({ title: 'Titled' })
events.uiStateSet = uiState.set.schema
events.settingsSet = settings.set.schema
events.counterSet = counter.set.schema

const out = {
  tables: Object.fromEntries(
    Object.entries(tables).map(([k, t]) => {
      const ast = t.sqliteDef.ast
      const docs = Object.fromEntries(
        ast.columns.map((c: any) => [
          c.name,
          SchemaRepresentation.toRepresentations([c.schema.ast, SchemaAST.toType(c.schema.ast)], { referencePolicy: () => undefined }),
        ]),
      )
      return [k, { fingerprint: fingerprint(ast), docs }]
    }),
  ),
  events: Object.fromEntries(Object.entries(events).map(([k, s]) => [k, { hash: Schema.hash(s), ast: JSON.stringify(s.ast, null, 2) }])),
}
const file = path.join(import.meta.dirname, '..', 'crates', 'livestore-schema', 'tests', 'fixtures', 'schema_hashes.json')
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
console.log(`wrote ${file}`)
