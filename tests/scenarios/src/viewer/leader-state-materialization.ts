import { type BootStatus, EventlogSqliteDb, MaterializationJournal, StateHead, StateSqliteDb } from '@livestore/common'
import { Eventlog, makeMaterializeEvent, recreateDb } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent, SystemTables, UNKNOWN_EVENT_SCHEMA_HASH } from '@livestore/common/schema'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/browser'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { Effect, Layer, Queue, Schema } from '@livestore/utils/effect'

import { getScenarioApplication } from '../corpus/applications/registry.ts'
import type {
  LeaderStateSource,
  ReconstructedLeaderState,
  ReconstructedTable,
  ReconstructedValue,
} from './leader-state.ts'

/**
 * Replays exactly the selected Leader observation's retained Event facts through real materializers.
 * The events go into a fresh eventlog with their recorded positions and origins, and core's state rebuild
 * (`recreateDb` → `rematerializeFromEventlog`) derives the State from it.
 */
export const materializeLeaderState = (source: LeaderStateSource): Promise<ReconstructedLeaderState> => {
  const { schema } = getScenarioApplication(source.applicationId)

  return Effect.gen(function* () {
    const makeSqliteDb = sqliteDbFactory({ sqlite3: yield* Effect.promise(() => loadSqlite3Wasm()) })
    const dbState = yield* makeSqliteDb({ _tag: 'in-memory' })
    const dbEventlog = yield* makeSqliteDb({ _tag: 'in-memory' })

    yield* Eventlog.initEventlogDb(dbEventlog)
    for (const event of source.observation.events) {
      const eventDef = schema.eventsDefsMap.get(event.name)
      yield* Eventlog.insertIntoEventlog(
        LiveStoreEvent.Client.Encoded.make({
          name: event.name,
          args: event.args,
          seqNum: EventSequenceNumber.Client.fromString(event.position),
          parentSeqNum: EventSequenceNumber.Client.fromString(event.parentPosition),
          clientId: event.origin.clientId,
          sessionId: event.origin.sessionId,
        }),
        dbEventlog,
        eventDef === undefined ? UNKNOWN_EVENT_SCHEMA_HASH : Schema.hash(eventDef.schema),
        event.origin.clientId,
        event.origin.sessionId,
      )
    }

    const sqliteDbLayer = Layer.mergeAll(StateSqliteDb.layer(dbState), EventlogSqliteDb.layer(dbEventlog))
    const servicesLayer = Layer.mergeAll(StateHead.layer, MaterializationJournal.layer).pipe(
      Layer.provideMerge(sqliteDbLayer),
    )
    yield* Effect.gen(function* () {
      const materializeEvent = yield* makeMaterializeEvent({ schema })
      yield* recreateDb({ schema, bootStatusQueue: yield* Queue.unbounded<BootStatus>(), materializeEvent })
    }).pipe(Effect.provide(servicesLayer))

    const tables: ReconstructedTable[] = []
    for (const [name, table] of schema.state.sqlite.tables) {
      if (SystemTables.isStateSystemTable(name) === true) continue
      const rawRows = (yield* Schema.decodeUnknownEffect(Schema.Array(table.rowSchema))(
        dbState.select(`SELECT * FROM '${name}'`),
      )) as ReadonlyArray<Readonly<Record<string, unknown>>>
      const columns = [
        ...new Set([...Object.keys(table.sqliteDef.columns), ...rawRows.flatMap((row) => Object.keys(row))]),
      ]
      tables.push({
        name,
        columns,
        rows: rawRows.map((row) =>
          Object.fromEntries(Object.entries(row).map(([column, value]) => [column, normalizeValue(value)])),
        ),
      })
    }
    return { source, tables }
  }).pipe(Effect.scoped, Effect.runPromise)
}

const normalizeValue = (value: unknown): ReconstructedValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) === true ? value : String(value)
  if (value instanceof Uint8Array) {
    return { bytesHex: [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
  }
  return String(value)
}
