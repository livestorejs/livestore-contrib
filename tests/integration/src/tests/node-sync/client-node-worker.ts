import './thread-polyfill.ts'
import path from 'node:path'

import { makeAdapter, makeWorkerAdapter } from '@livestore/adapter-node'
import { createStore, makeShutdownDeferred, queryDb } from '@livestore/livestore'
import { makeWsSync } from '@livestore/sync-cf/client'
import { IS_CI } from '@livestore/utils'
import { OtelLiveHttp } from '@livestore/utils-dev/node'
import {
  Deferred,
  Effect,
  OtelTracer,
  pipe,
  ReadonlyArray,
  References,
  RpcServer,
  RpcWorker,
  Scope,
  Stream,
} from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'
import { OtelLiveDummy, PlatformNode } from '@livestore/utils/node'

import { makeFileLogger } from './fixtures/file-logger.ts'
import { events, schema, tables } from './schema.ts'
import * as WorkerSchema from './worker-schema.ts'

const clientId = process.argv[2]!

const serviceName = `node-sync-test:${clientId}`

const makeWorkerRunnerInner = WorkerSchema.WorkerRpcs.toLayer(
  Effect.gen(function* () {
    const workerScope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(workerScope, exit))

    const workerContextOnce = yield* Effect.cached(
      Effect.gen(function* () {
        const { storeId, clientId, adapterType, storageType, params, syncUrl } = yield* RpcWorker.initialMessage(
          WorkerSchema.InitialMessage.payloadSchema,
        )

        const storage =
          storageType === 'fs'
            ? {
                type: 'fs' as const,
                baseDirectory: path.resolve(
                  process.cwd(),
                  `tmp`,
                  new Date().toISOString().split('T')[0]!, // `YYYY-MM-DD`
                  storeId,
                  clientId,
                ),
              }
            : { type: 'in-memory' as const }

        const sync = { backend: makeWsSync({ url: syncUrl }) }

        const adapter =
          adapterType === 'single-threaded'
            ? makeAdapter({ storage, clientId, sync })
            : makeWorkerAdapter({
                workerUrl: new URL('./livestore.worker.ts', import.meta.url),
                storage: { type: 'in-memory' },
                clientId,
                workerExtraArgs: { syncUrl },
              })

        const shutdownDeferred = yield* makeShutdownDeferred

        const store = yield* createStore({
          adapter,
          schema,
          storeId,
          disableDevtools: true,
          shutdownDeferred,
          params: {
            leaderPushBatchSize: params?.leaderPushBatchSize,
            simulation:
              params?.simulation !== undefined ? { clientSessionSyncProcessor: params.simulation } : undefined,
          },
        })
        // @ts-expect-error for debugging
        globalThis.store = store

        return { store, shutdownDeferred }
      }).pipe(
        Scope.provide(workerScope),
        Effect.orDie,
        Effect.annotateLogs({ clientId }),
        Effect.annotateSpans({ clientId }),
        Effect.withSpan(`@livestore/adapter-node-sync:test:init-${clientId}`),
      ),
    )

    return WorkerSchema.WorkerRpcs.of({
      CreateTodos: ({ count, commitBatchSize = 1 }) =>
        Effect.gen(function* () {
          // TODO check sync connection status
          const { store } = yield* workerContextOnce
          const otelSpan = yield* OtelTracer.currentOtelSpan
          const eventBatches = pipe(
            ReadonlyArray.range(0, count - 1),
            ReadonlyArray.map((i) => events.todoCreated({ id: nanoid(), title: `todo ${i} (${clientId})` })),
            ReadonlyArray.chunksOf(commitBatchSize),
          )
          const spanLinks = [{ context: otelSpan.spanContext() }]
          for (const batch of eventBatches) {
            store.commit({ spanLinks }, ...batch)
          }
        }).pipe(
          Effect.withSpan('@livestore/adapter-node-sync:test:create-todos', { attributes: { count } }),
          Effect.orDie,
        ),
      StreamTodos: () =>
        Effect.gen(function* () {
          const { store } = yield* workerContextOnce
          const query$ = queryDb(tables.todo.orderBy('id', 'desc'))
          return store.subscribeStream(query$)
        }).pipe(Stream.unwrap, Stream.withSpan('@livestore/adapter-node-sync:test:stream-todos')),
      OnShutdown: Effect.fn('@livestore/adapter-node-sync:test:on-shutdown')(function* () {
        const { shutdownDeferred } = yield* workerContextOnce
        yield* Deferred.await(shutdownDeferred).pipe(Effect.catchTag('StoreInterrupted', () => Effect.void))
      }),
    })
  }),
)

RpcServer.make(WorkerSchema.WorkerRpcs).pipe(
  Effect.provide(makeWorkerRunnerInner),
  Effect.provide(RpcServer.layerProtocolWorkerRunner),
  Effect.provide(PlatformNode.NodeWorkerRunner.layer),
  Effect.scoped,
  // TODO this parent span is currently missing in the trace
  Effect.withSpan(`@livestore/adapter-node-sync:run-worker-${clientId}`),
  Effect.provide(IS_CI === true ? OtelLiveDummy : OtelLiveHttp({ serviceName, skipLogUrl: true })),
  Effect.tapCauseLogPretty,
  Effect.annotateLogs({ thread: serviceName, clientId }),
  Effect.annotateSpans({ clientId }),
  Effect.provide(makeFileLogger(`worker-${clientId}`)),
  Effect.provide(PlatformNode.NodeServices.layer),
  Effect.provideService(References.MinimumLogLevel, 'Debug'),
  PlatformNode.NodeRuntime.runMain,
)
