import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { EventSequenceNumber, LiveStoreEvent, SystemTables } from '@livestore/common/schema'
import { createStorePromise, StoreInternalsSymbol } from '@livestore/livestore'
import { Effect } from '@livestore/utils/effect'

import { getScenarioApplication } from '../corpus/applications/registry.ts'
import type {
  LeaderStateSource,
  ReconstructedLeaderState,
  ReconstructedTable,
  ReconstructedValue,
} from './leader-state.ts'

let storeSequence = 0

/** Replays exactly the selected Leader observation's retained Event facts through real materializers. */
export const materializeLeaderState = async (source: LeaderStateSource): Promise<ReconstructedLeaderState> => {
  const application = getScenarioApplication(source.applicationId)
  storeSequence += 1
  const store = await createStorePromise({
    schema: application.schema,
    storeId: `scenario-viewer-reconstruction-${storeSequence}`,
    disableDevtools: true,
    adapter: makeInMemoryAdapter({
      clientId: `viewer-${source.clientId}`,
      sessionId: 'reconstruction',
    }),
  })

  try {
    const events = source.observation.events.map(
      (event) =>
        new LiveStoreEvent.Client.EncodedWithMeta({
          name: event.name,
          args: event.args,
          seqNum: EventSequenceNumber.Client.fromString(event.position),
          parentSeqNum: EventSequenceNumber.Client.fromString(event.parentPosition),
          clientId: event.origin.clientId,
          sessionId: event.origin.sessionId,
        }),
    )
    await Effect.runPromise(store[StoreInternalsSymbol].syncProcessor.materializeEvents(events))

    const tables: ReconstructedTable[] = []
    for (const [name, table] of application.schema.state.sqlite.tables) {
      if (SystemTables.isStateSystemTable(name) === true) continue
      const rawRows = store.query(table) as ReadonlyArray<Readonly<Record<string, unknown>>>
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
  } finally {
    await store.shutdownPromise()
  }
}

const normalizeValue = (value: unknown): ReconstructedValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) === true ? value : String(value)
  if (value instanceof Uint8Array) {
    return { bytesHex: [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
  }
  return String(value)
}
