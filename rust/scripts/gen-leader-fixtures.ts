/**
 * Drives the real TS leader persistence (materializeEvent + LeaderPersistence + recreateDb) and the real
 * `merge` with the TodoMVC schema through scripted scenarios, and dumps rows after every op into
 * `fixtures/leader/`. The Rust leader replays the same ops and must produce the same rows.
 *
 * Ops:
 * - commit: local event numbered with `nextPair(localHead)`, merged as local-push, persisted locally.
 * - pull: global events from the backend, merged as upstream-advance (ignoring client-only), persisted upstream.
 * - rebuild: fresh state DB rebuilt from the eventlog (the sync state is kept, as in a restart without new events).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Effect, Exit, Option, Queue, Schema } from '../../repos/livestore/packages/@livestore/utils/src/effect/mod.ts'

import { EventlogSqliteDb, MaterializationJournal, SessionIdSymbol, StateHead, StateSqliteDb } from '../../repos/livestore/packages/@livestore/common/src/index.ts'
import type { SqliteDb } from '../../repos/livestore/packages/@livestore/common/src/index.ts'
import { Eventlog, LeaderPersistence, makeMaterializeEvent, recreateDb } from '../../repos/livestore/packages/@livestore/common/src/leader-thread/mod.ts'
import { EventSequenceNumber, Events, LiveStoreEvent, makeSchema, State } from '../../repos/livestore/packages/@livestore/common/src/schema/mod.ts'
import * as SyncState from '../../repos/livestore/packages/@livestore/common/src/sync/syncstate.ts'
import { Layer } from '../../repos/livestore/packages/@livestore/utils/src/effect/mod.ts'
import { loadSqlite3Wasm } from '../../repos/livestore/packages/@livestore/sqlite-wasm/src/load-wasm/mod.node.ts'
import { NodeFileSystem } from '../../repos/livestore/packages/@livestore/utils/src/node/mod.ts'
import { sqliteDbFactory } from '../../repos/livestore/packages/@livestore/sqlite-wasm/src/node/mod.ts'

// Copy of examples/web-todomvc-sync-cf/src/livestore/schema.ts (that file imports the umbrella package).
const tables = {
  todos: State.SQLite.table({
    name: 'todos',
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      text: State.SQLite.text({ default: '' }),
      completed: State.SQLite.boolean({ default: false }),
      deletedAt: State.SQLite.integer({ nullable: true, schema: Schema.DateFromMillis }),
    },
  }),
  uiState: State.SQLite.clientDocument({
    name: 'uiState',
    schema: Schema.Struct({ newTodoText: Schema.String, filter: Schema.Literals(['all', 'active', 'completed']) }),
    default: { id: SessionIdSymbol, value: { newTodoText: '', filter: 'all' } },
  }),
}

const events = {
  todoCreated: Events.synced({ name: 'v1.TodoCreated', schema: Schema.Struct({ id: Schema.String, text: Schema.String }) }),
  todoCompleted: Events.synced({ name: 'v1.TodoCompleted', schema: Schema.Struct({ id: Schema.String }) }),
  todoUncompleted: Events.synced({ name: 'v1.TodoUncompleted', schema: Schema.Struct({ id: Schema.String }) }),
  todoDeleted: Events.synced({
    name: 'v1.TodoDeleted',
    schema: Schema.Struct({ id: Schema.String, deletedAt: Schema.DateFromString }),
  }),
  todoClearedCompleted: Events.synced({
    name: 'v1.TodoClearedCompleted',
    schema: Schema.Struct({ deletedAt: Schema.DateFromString }),
  }),
  uiStateSet: tables.uiState.set,
}

const materializers = State.SQLite.materializers(events, {
  'v1.TodoCreated': ({ id, text }) => tables.todos.insert({ id, text, completed: false }),
  'v1.TodoCompleted': ({ id }) => tables.todos.update({ completed: true }).where({ id }),
  'v1.TodoUncompleted': ({ id }) => tables.todos.update({ completed: false }).where({ id }),
  'v1.TodoDeleted': ({ id, deletedAt }) => tables.todos.update({ deletedAt }).where({ id }),
  'v1.TodoClearedCompleted': ({ deletedAt }) => tables.todos.update({ deletedAt }).where({ completed: true }),
})

const schema = makeSchema({ events, state: State.SQLite.makeState({ tables, materializers }) })

const CLIENT_ID = 'client-a'
const SESSION_ID = 'session-a'
const outDir = path.join(import.meta.dirname, '..', 'fixtures', 'leader')

type GlobalEvent = { name: string; args: unknown; seqNum: number; parentSeqNum: number; clientId: string; sessionId: string; metadata?: unknown }
type Op = { op: 'commit'; name: string; args: unknown } | { op: 'pull'; events: GlobalEvent[] } | { op: 'rebuild' }

const other = (seqNum: number, name: string, args: unknown, metadata?: unknown): GlobalEvent => ({
  name,
  args,
  seqNum,
  parentSeqNum: seqNum - 1,
  clientId: 'client-b',
  sessionId: 'session-b',
  ...(metadata === undefined ? {} : { metadata }),
})
const mine = (seqNum: number, name: string, args: unknown, metadata?: unknown): GlobalEvent => ({
  ...other(seqNum, name, args, metadata),
  clientId: CLIENT_ID,
  sessionId: SESSION_ID,
})
const commit = (name: string, args: unknown): Op => ({ op: 'commit', name, args })
const created = (id: string, text: string) => commit('v1.TodoCreated', { id, text })
const D1 = '2026-01-02T03:04:05.678Z'

const scenarios: Record<string, Op[]> = {
  'local-commits': [
    created('a', 'Buy milk'),
    created('b', 'Walk dog'),
    commit('v1.TodoCompleted', { id: 'a' }),
    commit('v1.TodoUncompleted', { id: 'a' }),
    commit('v1.TodoCompleted', { id: 'b' }),
    commit('v1.TodoClearedCompleted', { deletedAt: D1 }),
    commit('v1.TodoDeleted', { id: 'a', deletedAt: '2026-02-03T00:00:00.000Z' }),
    commit('v1.TodoCompleted', { id: 'missing' }),
  ],
  'failed-local-commit': [created('a', 'One'), created('a', 'Duplicate'), created('b', 'Two')],
  'failed-upstream-batch': [
    created('a', 'Pending'),
    { op: 'pull', events: [other(1, 'v1.TodoCreated', { id: 'dup', text: 'First' }), other(2, 'v1.TodoCreated', { id: 'dup', text: 'Second' })] },
    { op: 'pull', events: [other(1, 'v1.TodoCreated', { id: 'ok', text: 'Fine' }, { cursor: 1 })] },
  ],
  'confirm-own-events': [
    created('a', 'Mine'),
    created('b', 'Mine too'),
    { op: 'pull', events: [mine(1, 'v1.TodoCreated', { id: 'a', text: 'Mine' }, { cursor: 'c1' })] },
    { op: 'pull', events: [mine(2, 'v1.TodoCreated', { id: 'b', text: 'Mine too' }, { cursor: 'c2' })] },
  ],
  'upstream-advance-no-pending': [
    { op: 'pull', events: [other(1, 'v1.TodoCreated', { id: 'x', text: 'Remote' }, { cursor: 1 }), other(2, 'v1.TodoCompleted', { id: 'x' })] },
    created('a', 'Local after remote'),
  ],
  rebase: [
    created('a', 'Local A'),
    commit('v1.TodoCompleted', { id: 'a' }),
    {
      op: 'pull',
      events: [
        other(1, 'v1.TodoCreated', { id: 'x', text: 'Remote X' }, { cursor: 'r1' }),
        other(2, 'v1.TodoCreated', { id: 'y', text: 'Remote Y' }),
      ],
    },
    created('b', 'Local B after rebase'),
    {
      op: 'pull',
      events: [
        mine(3, 'v1.TodoCreated', { id: 'a', text: 'Local A' }, { cursor: 'r3' }),
        mine(4, 'v1.TodoCompleted', { id: 'a' }),
      ],
    },
  ],
  'rebase-conflicting-rows': [
    created('a', 'Local'),
    commit('v1.TodoCompleted', { id: 'a' }),
    { op: 'pull', events: [other(1, 'v1.TodoCreated', { id: 'z', text: 'Remote first' }), other(2, 'v1.TodoCompleted', { id: 'z' })] },
    commit('v1.TodoClearedCompleted', { deletedAt: D1 }),
    { op: 'pull', events: [other(3, 'v1.TodoUncompleted', { id: 'z' })] },
  ],
  'client-document': [
    commit('uiStateSet', { id: SESSION_ID, value: { filter: 'active' } }),
    created('a', 'Synced'),
    commit('uiStateSet', { id: SESSION_ID, value: { newTodoText: 'draft' } }),
    { op: 'pull', events: [other(1, 'v1.TodoCreated', { id: 'r', text: 'Remote' })] },
    commit('uiStateSet', { id: 'other-session', value: { newTodoText: 'x', filter: 'completed' } }),
    { op: 'rebuild' },
  ],
  'unknown-events': [
    { op: 'pull', events: [other(1, 'v9.FutureEvent', { foo: 1 }, { cursor: 'u1' }), other(2, 'v1.TodoCreated', { id: 'k', text: 'Known' })] },
    created('a', 'Local'),
    { op: 'pull', events: [other(3, 'v9.FutureEvent', { bar: [1, 2] })] },
    { op: 'rebuild' },
  ],
  rebuild: [
    created('a', 'A'),
    commit('v1.TodoCompleted', { id: 'a' }),
    { op: 'pull', events: [other(1, 'v1.TodoCreated', { id: 'x', text: 'X' })] },
    { op: 'rebuild' },
    created('b', 'B'),
  ],
}

const main = Effect.gen(function* () {
  mkdirSync(outDir, { recursive: true })
  const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm())
  const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })

  const makeState = (dbEventlog: SqliteDb) =>
    Effect.gen(function* () {
      const dbState = yield* makeSqliteDb({ _tag: 'in-memory' })
      const services = Layer.mergeAll(StateSqliteDb.layer(dbState), EventlogSqliteDb.layer(dbEventlog))
      const layer = Layer.mergeAll(
        services,
        Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(Layer.provide(services)),
      )
      const materializeEvent = yield* makeMaterializeEvent({ schema }).pipe(Effect.provide(layer))
      const bootStatusQueue = yield* Queue.unbounded<any>()
      yield* recreateDb({ schema, bootStatusQueue, materializeEvent }).pipe(Effect.provide(layer))
      const persistence = yield* LeaderPersistence.make({ materializeEvent }).pipe(Effect.provide(layer))
      return { dbState, persistence }
    })

  for (const [name, ops] of Object.entries(scenarios)) {
    const dbEventlog = yield* makeSqliteDb({ _tag: 'in-memory' })
    yield* Eventlog.initEventlogDb(dbEventlog)
    let { dbState, persistence } = yield* makeState(dbEventlog)
    let syncState = SyncState.SyncState.make({
      pending: [],
      upstreamHead: EventSequenceNumber.Client.ROOT,
      localHead: EventSequenceNumber.Client.ROOT,
    })
    const steps: unknown[] = []

    for (const op of ops) {
      let result = 'ok'
      if (op.op === 'commit') {
        const head = syncState.localHead
        const isClientOnly = schema.eventsDefsMap.get(op.name)?.options.clientOnly === true
        const { seqNum, parentSeqNum } = EventSequenceNumber.Client.nextPair({ seqNum: head, isClientOnly })
        const event = LiveStoreEvent.Client.Encoded.make({ name: op.name, args: op.args, seqNum, parentSeqNum, clientId: CLIENT_ID, sessionId: SESSION_ID })
        const merge = yield* SyncState.merge({ syncState, payload: { _tag: 'local-push', newEvents: [event] }, isClientOnlyEvent, isEqualEvent: LiveStoreEvent.Client.isEqualEncoded })
        if (merge._tag !== 'advance') throw new Error(`unexpected ${merge._tag}`)
        const exit = yield* persistence.persistLocal({ events: merge.newEvents }).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) syncState = merge.newSyncState
        else result = 'error'
      } else if (op.op === 'pull') {
        const pulled = op.events.map(({ metadata, ...e }) => ({
          event: LiveStoreEvent.Client.Encoded.make({
            ...e,
            seqNum: EventSequenceNumber.Client.Composite.make({ global: e.seqNum, client: 0, rebaseGeneration: 0 }),
            parentSeqNum: EventSequenceNumber.Client.Composite.make({ global: e.parentSeqNum, client: 0, rebaseGeneration: 0 }),
          }),
          syncMetadata: metadata === undefined ? Option.none() : Option.some(metadata as any),
        }))
        const newEvents = pulled.map((p) => p.event)
        const merge = yield* SyncState.merge({ syncState, payload: SyncState.PayloadUpstreamAdvance.make({ newEvents }), isClientOnlyEvent, isEqualEvent: LiveStoreEvent.Client.isEqualEncoded, ignoreClientOnlyEvents: true })
        if (merge._tag === 'reject') throw new Error('reject')
        const exit = yield* persistence
          .persistUpstream({
            pulledEvents: pulled,
            events: merge.newEvents,
            rollbackEvents: merge._tag === 'rebase' ? merge.rollbackEvents : [],
            confirmedEvents: merge._tag === 'advance' ? merge.confirmedEvents : [],
            backendHead: newEvents.at(-1)!.seqNum,
          })
          .pipe(Effect.exit)
        if (Exit.isSuccess(exit)) syncState = merge.newSyncState
        else result = 'error'
      } else {
        ;({ dbState, persistence } = yield* makeState(dbEventlog))
      }
      steps.push({ op, result, snapshot: snapshot(dbState, dbEventlog, syncState) })
    }

    const ddl = {
      state: dbState.select(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name`),
      eventlog: dbEventlog.select(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name`),
    }
    writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify({ name, clientId: CLIENT_ID, sessionId: SESSION_ID, steps, ddl }, null, 2)}\n`)
    console.log(`wrote ${name}`)
  }
})

const isClientOnlyEvent = (event: LiveStoreEvent.Client.Encoded) => schema.eventsDefsMap.get(event.name)?.options.clientOnly === true

const snapshot = (dbState: SqliteDb, dbEventlog: SqliteDb, syncState: SyncState.SyncState) => ({
  todos: dbState.select(`SELECT * FROM todos ORDER BY id`),
  uiState: dbState.select(`SELECT * FROM uiState ORDER BY id`),
  stateHead: dbState.select(`SELECT * FROM __livestore_state_head`),
  journalKeys: dbState.select(
    `SELECT seqNumGlobal, seqNumClient, seqNumRebaseGeneration, changeset IS NULL AS changesetIsNull FROM __livestore_materialization_journal ORDER BY 1, 2, 3`,
  ),
  rebuildMarker: dbState.select(`SELECT * FROM __livestore_rebuild`),
  eventlog: dbEventlog.select(
    `SELECT seqNumGlobal, seqNumClient, seqNumRebaseGeneration, parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration, name, argsJson, clientId, sessionId, schemaHash, syncMetadataJson FROM eventlog ORDER BY 1, 2, 3`,
  ),
  syncStatus: dbEventlog.select(`SELECT * FROM __livestore_sync_status`),
  schemaMeta: dbState.select(`SELECT tableName, schemaHash FROM __livestore_schema ORDER BY tableName`),
  eventDefs: dbState.select(`SELECT eventName, schemaHash FROM __livestore_schema_event_defs ORDER BY eventName`),
  syncState: { pending: syncState.pending, upstreamHead: syncState.upstreamHead, localHead: syncState.localHead },
})

Effect.runPromise(main.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<void, unknown>).catch((error) => {
  console.error(error)
  process.exit(1)
})
