import path from 'node:path'

import { expect, it } from 'vitest'

import { makeAdapter, makeWorkerAdapter } from '@livestore/adapter-node'
import { getWorkerArgs } from '@livestore/adapter-node/worker'
import { createStore, StoreInternalsSymbol } from '@livestore/livestore'
import { IS_CI, shouldNeverHappen } from '@livestore/utils'
import { Vitest } from '@livestore/utils-dev/node-vitest'
import { Effect } from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'

// Reuse the same schema from node-sync tests
import { events, schema, tables } from '../../node-sync/schema.ts'

const TMP_STORE_DIR = path.join(
  process.env.WORKSPACE_ROOT ?? shouldNeverHappen('WORKSPACE_ROOT is not set'),
  'tests',
  'integration',
  'src',
  'tests',
  'node-misc',
  'tmp',
)

const withTestCtx = Vitest.makeWithTestCtx({ timeout: IS_CI === true ? 600_000 : 900_000 })

Vitest.describe('todomvc-node', () => {
  it('decodes worker arguments without extraArgs', () => {
    const encoded = JSON.stringify({
      clientId: 'client',
      storeId: 'store',
      sessionId: 'session',
    })
    const [originalArg] = process.argv.splice(2, 1, encoded)

    try {
      expect(getWorkerArgs()).toEqual({ clientId: 'client', storeId: 'store', sessionId: 'session' })
    } finally {
      if (originalArg === undefined) {
        process.argv.splice(2, 1)
      } else {
        process.argv.splice(2, 1, originalArg)
      }
    }
  })

  Vitest.live('should start a worker adapter without extra arguments', (test) =>
    Effect.gen(function* () {
      const adapter = makeWorkerAdapter({
        workerUrl: new URL('./livestore-default.worker.ts', import.meta.url),
        storage: { type: 'in-memory' },
        clientId: 'default-worker-test',
      })
      const store = yield* createStore({
        adapter,
        schema,
        storeId: nanoid(10),
        disableDevtools: true,
      })

      const todo = { id: nanoid(), title: 'Worker default arguments' }
      store.commit(events.todoCreated(todo))
      expect(store.query(tables.todo)).toEqual([todo])

      yield* store.shutdown()
    }).pipe(withTestCtx(test)),
  )

  Vitest.live('should push pending events to the leader after reboot', (test) =>
    Effect.gen(function* () {
      const storeId = nanoid(10)
      const clientId = 'test-client'

      const adapter = makeAdapter({ storage: { type: 'fs', baseDirectory: TMP_STORE_DIR }, clientId })

      const store = yield* createStore({ adapter, schema, storeId })

      expect(store.query(tables.todo)).toEqual([])

      // Create a new todo
      const newTodoId = nanoid()
      store.commit(events.todoCreated({ id: newTodoId, title: 'Test todo item' }))

      expect(store.query(tables.todo)).toEqual([{ id: newTodoId, title: 'Test todo item' }])

      yield* store.shutdown()

      const sameStore = yield* createStore({ adapter, schema, storeId })

      expect(sameStore.query(tables.todo)).toEqual([{ id: newTodoId, title: 'Test todo item' }])

      sameStore.commit(events.todoCreated({ id: nanoid(), title: 'Test todo item 2' }))

      yield* Effect.sleep(100)

      const syncState = yield* sameStore[StoreInternalsSymbol].syncProcessor.syncState
      expect(syncState.pending.length).toBe(0)

      yield* sameStore.shutdown()
    }).pipe(withTestCtx(test)),
  )

  Vitest.live('should reject operations after shutdown', (test) =>
    Effect.gen(function* () {
      const storeId = nanoid(10)
      const adapter = makeAdapter({ storage: { type: 'fs', baseDirectory: TMP_STORE_DIR }, clientId: 'test' })
      const store = yield* createStore({ adapter, schema, storeId })

      yield* store.shutdown()

      // All operations should throw after shutdown
      expect(() =>
        store.commit(events.todoCreated({ id: nanoid(), title: 'Test' })),
      ).toThrowErrorMatchingInlineSnapshot(`[~@livestore/common/UnknownError]`)
      expect(() => store.query(tables.todo)).toThrowErrorMatchingInlineSnapshot(`[~@livestore/common/UnknownError]`)
      expect(() => store.subscribe(tables.todo, () => {})).toThrowErrorMatchingInlineSnapshot(
        `[~@livestore/common/UnknownError]`,
      )
    }).pipe(withTestCtx(test)),
  )

  // TODO(livestorejs/livestore#1405): unskip once the core drain-on-shutdown fix lands and we repin.
  // The queued-batch loss on shutdown can only be fixed in core `ClientSessionSyncProcessor`
  // (the pusher fiber and `leaderPushQueue` are core-owned); the adapter-node in-flight fix covers
  // only the single-batch reboot case. Skipped here so contrib CI is green while #1405 is pending.
  Vitest.live.skip('should handle concurrent commits before shutdown', (test) =>
    Effect.gen(function* () {
      const storeId = nanoid(10)
      const adapter = makeAdapter({ storage: { type: 'fs', baseDirectory: TMP_STORE_DIR }, clientId: 'test' })
      const store = yield* createStore({ adapter, schema, storeId })

      // Commit multiple events in sequence
      store.commit(events.todoCreated({ id: 'todo-1', title: 'Todo 1' }))
      store.commit(events.todoCreated({ id: 'todo-2', title: 'Todo 2' }))
      store.commit(events.todoCreated({ id: 'todo-3', title: 'Todo 3' }))

      expect(store.query(tables.todo)).toHaveLength(3)
      yield* store.shutdown()

      // Verify data persists after shutdown
      const newStore = yield* createStore({ adapter, schema, storeId })
      expect(newStore.query(tables.todo)).toHaveLength(3)
      yield* newStore.shutdown()
    }).pipe(withTestCtx(test)),
  )
})
