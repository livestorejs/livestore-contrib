import './thread-polyfill.ts'
import inspector from 'node:inspector'

if (process.execArgv.includes('--inspect') === true) {
  inspector.open()
  inspector.waitForDebugger()
}

import type { SyncOptions } from '@livestore/common'
import { LogConfig, UnknownError } from '@livestore/common'
import type { StreamEventsOptions } from '@livestore/common/leader-thread'
import { Eventlog, LeaderThreadCtx, streamEventsWithSyncState } from '@livestore/common/leader-thread'
import type { LiveStoreSchema } from '@livestore/common/schema'
import { LiveStoreEvent } from '@livestore/common/schema'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { isDevEnv } from '@livestore/utils'
import {
  Effect,
  FetchHttpClient,
  Layer,
  OtelTracer,
  Queue,
  References,
  RpcServer,
  RpcWorker,
  Schema,
  Scope,
  Stream,
} from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'
import type * as otel from '@opentelemetry/api'

import type { TestingOverrides } from './leader-thread-shared.ts'
import { makeLeaderThread } from './leader-thread-shared.ts'
import * as WorkerSchema from './worker-schema.ts'

export type WorkerOptions = {
  schema: LiveStoreSchema
  sync?: SyncOptions
  syncPayloadSchema?: Schema.Schema<any>
  otelOptions?: {
    tracer?: otel.Tracer
    /** @default 'livestore-node-leader-thread' */
    serviceName?: string
  }
  testing?: TestingOverrides
} & LogConfig.LoggerOptions

export const getWorkerArgs = () => Schema.decodeSync(WorkerSchema.WorkerArgv)(process.argv[2]!)

export const makeWorker = (options: WorkerOptions) => {
  makeWorkerEffect(options).pipe(PlatformNode.NodeRuntime.runMain)
}

export const makeWorkerEffect = (options: WorkerOptions) => {
  const TracingLive =
    options.otelOptions?.tracer !== undefined
      ? OtelTracer.layerWithoutOtelTracer.pipe(
          Layer.provideMerge(Layer.succeed(OtelTracer.OtelTracer, options.otelOptions.tracer)),
        )
      : Layer.empty

  // Merge the runtime dependencies once so we can provide them together without chaining Effect.provide.
  const runtimeLayer = Layer.mergeAll(FetchHttpClient.layer, PlatformNode.NodeFileSystem.layer, TracingLive)
  const workerProtocolLayer = RpcServer.layerProtocolWorkerRunner.pipe(
    Layer.provideMerge(PlatformNode.NodeWorkerRunner.layer),
  )
  const workerLayer = makeWorkerRunnerInner(options).pipe(
    Layer.provideMerge(workerProtocolLayer),
    Layer.provide(runtimeLayer),
  )

  return RpcServer.make(WorkerSchema.LeaderWorkerInnerRpcs).pipe(
    Effect.scoped,
    Effect.tapCauseLogPretty,
    Effect.annotateLogs({
      thread: options.otelOptions?.serviceName ?? 'livestore-node-leader-thread',
      processId: process.pid,
    }),
    Effect.provide([
      workerLayer,
      Layer.mergeAll(
        options.logger ?? Layer.empty,
        Layer.succeed(References.MinimumLogLevel, options.logLevel ?? (isDevEnv() === true ? 'Debug' : 'Info')),
      ),
    ]),
  )
}

const makeWorkerRunnerInner = (options: WorkerOptions) =>
  WorkerSchema.LeaderWorkerInnerRpcs.toLayer(
    Effect.gen(function* () {
      const leaderThreadScope = yield* Scope.make()
      yield* Effect.addFinalizer((exit) => Scope.close(leaderThreadScope, exit))

      const leaderThreadContextOnce = yield* Effect.cached(
        Effect.gen(function* () {
          const { storeId, clientId, storage, devtools, syncPayloadEncoded } = yield* RpcWorker.initialMessage(
            WorkerSchema.LeaderWorkerInnerInitialMessage.payloadSchema,
          )

          const sqlite3 = yield* Effect.promise(() => loadSqlite3Wasm()).pipe(
            Effect.withSpan('@livestore/adapter-node:leader-thread:loadSqlite3Wasm'),
          )
          const makeSqliteDb = yield* sqliteDbFactory({ sqlite3 })

          const layer = yield* makeLeaderThread({
            storeId,
            clientId,
            storage,
            devtools,
            syncOptions: options.sync,
            schema: options.schema,
            testing: options.testing,
            makeSqliteDb,
            syncPayloadEncoded,
            syncPayloadSchema: options.syncPayloadSchema,
          })

          return yield* Layer.buildWithScope(layer, leaderThreadScope)
        }).pipe(
          Scope.provide(leaderThreadScope),
          Effect.tapCauseLogPretty,
          UnknownError.mapToUnknownError,
          Effect.withSpan('@livestore/adapter-node:worker:InitialMessage'),
          Effect.orDie,
        ),
      )

      const provideLeaderThread = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const leaderThreadContext = yield* leaderThreadContextOnce
          return yield* effect.pipe(Effect.provide(leaderThreadContext))
        })

      return WorkerSchema.LeaderWorkerInnerRpcs.of({
        GetRecreateSnapshot: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            const snapshot = workerCtx.dbState.export()
            return { snapshot, migrationsReport: workerCtx.initialState.migrationsReport }
          }).pipe(provideLeaderThread, Effect.withSpan('@livestore/adapter-node:worker:GetRecreateSnapshot')),
        PullStream: ({ cursor }) =>
          Effect.gen(function* () {
            const { syncProcessor } = yield* LeaderThreadCtx
            return syncProcessor.pull({ cursor })
          }).pipe(provideLeaderThread, Stream.unwrap),
        PushToLeader: ({ batch }) =>
          Effect.andThen(LeaderThreadCtx, ({ syncProcessor }) =>
            syncProcessor.push(batch.map((event) => new LiveStoreEvent.Client.EncodedWithMeta(event))),
          ).pipe(provideLeaderThread, Effect.uninterruptible, Effect.withSpan('@livestore/adapter-node:worker:PushToLeader')),
        StreamEvents: (options) =>
          LeaderThreadCtx.pipe(
            Effect.map(({ dbEventlog, syncProcessor }) =>
              streamEventsWithSyncState({
                dbEventlog,
                syncState: syncProcessor.syncState,
                options: options as StreamEventsOptions,
              }),
            ),
            provideLeaderThread,
            Stream.unwrap,
            Stream.withSpan('@livestore/adapter-node:worker:StreamEvents'),
          ),
        Export: () =>
          LeaderThreadCtx.pipe(
            Effect.flatMap((_) => Effect.sync(() => _.dbState.export())),
            provideLeaderThread,
            Effect.withSpan('@livestore/adapter-node:worker:Export'),
          ),
        ExportEventlog: () =>
          LeaderThreadCtx.pipe(
            Effect.flatMap((_) => Effect.sync(() => _.dbEventlog.export())),
            provideLeaderThread,
            Effect.withSpan('@livestore/adapter-node:worker:ExportEventlog'),
          ),
        BootStatusStream: () =>
          LeaderThreadCtx.pipe(
            Effect.map((_) => Stream.fromQueue(_.bootStatusQueue)),
            provideLeaderThread,
            Stream.unwrap,
          ),
        GetLeaderHead: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return Eventlog.getClientHeadFromDb(workerCtx.dbEventlog)
          }).pipe(provideLeaderThread, Effect.withSpan('@livestore/adapter-node:worker:GetLeaderHead')),
        GetLeaderSyncState: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return yield* workerCtx.syncProcessor.syncState
          }).pipe(provideLeaderThread, Effect.withSpan('@livestore/adapter-node:worker:GetLeaderSyncState')),
        SyncStateStream: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return workerCtx.syncProcessor.syncState.changes
          }).pipe(provideLeaderThread, Stream.unwrap),
        GetNetworkStatus: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return yield* workerCtx.networkStatus
          }).pipe(provideLeaderThread, Effect.withSpan('@livestore/adapter-node:worker:GetNetworkStatus')),
        NetworkStatusStream: () =>
          Effect.gen(function* () {
            const workerCtx = yield* LeaderThreadCtx
            return workerCtx.networkStatus.changes
          }).pipe(provideLeaderThread, Stream.unwrap),
        Shutdown: Effect.fn('@livestore/adapter-node:worker:Shutdown')(function* () {
          yield* Effect.logDebug('[@livestore/adapter-node:worker] Shutdown')
        }),
        ExtraDevtoolsMessage: ({ message }) =>
          Effect.andThen(LeaderThreadCtx, (_) => Queue.offer(_.extraIncomingMessagesQueue, message)).pipe(
            provideLeaderThread,
            Effect.asVoid,
            Effect.withSpan('@livestore/adapter-node:worker:ExtraDevtoolsMessage'),
          ),
      })
    }),
  )
