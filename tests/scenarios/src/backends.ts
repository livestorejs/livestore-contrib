import path from 'node:path'

import { makeMockSyncBackend, SyncBackend, UnknownError } from '@livestore/common'
import type { LiveStoreEvent } from '@livestore/common/schema'
import { makeWsSync } from '@livestore/sync-cf/client'
import { type SyncMessage } from '@livestore/sync-cf/common'
import { WranglerDevServer } from '@livestore/utils-dev/wrangler'
import {
  Effect,
  FetchHttpClient,
  type FileSystem,
  type HttpClient,
  KeyValueStore,
  Layer,
  Option,
  type Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from '@livestore/utils/effect'

import { makeAvailabilityProxy } from './availability-proxy.ts'

export interface BackendSnapshot {
  readonly connected: boolean
  readonly events: ReadonlyArray<LiveStoreEvent.Global.Encoded>
}

export type SerializedBackendConfig = ScenarioBackend['serializedConfig']

/** Backend realization owned by the runner, independently of participant placement. */
export interface ScenarioBackend<TSyncMetadata = Schema.Json> {
  readonly id: 'mock' | 'local-sync-cf'
  readonly makeBackend: (
    args: SyncBackend.MakeBackendArgs,
  ) => Effect.Effect<SyncBackend.SyncBackend<TSyncMetadata>, UnknownError, Scope.Scope>
  readonly observe: (storeId: string) => Effect.Effect<BackendSnapshot, UnknownError, Scope.Scope>
  readonly setAvailability: (available: boolean) => Effect.Effect<void, UnknownError>
  readonly serializedConfig:
    | { readonly _tag: 'mock' }
    | { readonly _tag: 'sync-cf-ws'; readonly url: string; readonly storeIdSuffix: string }
  readonly componentVersions: Readonly<Record<string, string>>
}

/** Applies runner-controlled connectivity without replacing the real provider implementation. */
export const makeConnectivityControlledBackend = <TSyncMetadata>(args: {
  clientId: string
  connectivity: SubscriptionRef.SubscriptionRef<boolean>
  underlying: SyncBackend.SyncBackend<TSyncMetadata>
}): SyncBackend.SyncBackend<TSyncMetadata> =>
  SyncBackend.of({
    ...args.underlying,
    connect: args.underlying.connect,
    isConnected: args.connectivity,
    metadata: {
      ...args.underlying.metadata,
      name: '@local/scenario-controlled-sync',
      description: `Scenario-controlled sync backend for ${args.clientId}`,
    },
  })

export const makeMockScenarioBackend: Effect.Effect<ScenarioBackend, UnknownError, Scope.Scope> = Effect.gen(
  function* () {
    const backend = yield* makeMockSyncBackend({ startConnected: true })

    return {
      id: 'mock',
      makeBackend: () => backend.makeSyncBackend,
      observe: () =>
        Effect.all({
          connected: SubscriptionRef.get(backend.isConnected),
          events: backend.events,
        }),
      setAvailability: (available) => (available === true ? backend.connect : backend.disconnect),
      serializedConfig: { _tag: 'mock' },
      componentVersions: { '@livestore/common/mock-sync-backend': 'workspace' },
    } satisfies ScenarioBackend
  },
)

/** Starts the repository's real sync-cf worker and SQLite Durable Object under local workerd. */
export const makeLocalSyncCfScenarioBackend: Effect.Effect<
  ScenarioBackend<SyncMessage.SyncMetadata>,
  WranglerDevServer.WranglerDevServerError | UnknownError,
  Scope.Scope | FileSystem.FileSystem | HttpClient.HttpClient
> = Effect.gen(function* () {
  const server = yield* WranglerDevServer.make({
    cwd: path.join(import.meta.dirname, 'backends', 'sync-cf'),
    showLogs: process.env.SCENARIO_BACKEND_LOGS === '1',
  })
  const availabilityProxy = yield* makeAvailabilityProxy(server.url)
  const storeIdSuffix = `scenario-${process.pid}-${Date.now()}`
  const physicalStoreId = (storeId: string) => `${storeId}-${storeIdSuffix}`
  const makeWsBackend = makeWsSync({ url: availabilityProxy.url })
  const makeObserverBackend = makeWsSync({ url: server.url })
  const makeBackend = (args: SyncBackend.MakeBackendArgs) =>
    makeWsBackend({ ...args, storeId: physicalStoreId(args.storeId) }).pipe(
      Effect.provide(Layer.mergeAll(FetchHttpClient.layer, KeyValueStore.layerMemory)),
    )
  const observers = new Map<string, SyncBackend.SyncBackend<SyncMessage.SyncMetadata>>()

  const getObserver = (storeId: string) =>
    Effect.gen(function* () {
      const existing = observers.get(storeId)
      if (existing !== undefined) return existing
      const observer = yield* makeObserverBackend({
        storeId: physicalStoreId(storeId),
        clientId: 'scenario-backend-observer',
        payload: undefined,
      }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, KeyValueStore.layerMemory)))
      yield* observer.connect
      observers.set(storeId, observer)
      return observer
    })

  return {
    id: 'local-sync-cf',
    makeBackend,
    observe: (storeId: string) =>
      Effect.gen(function* () {
        const observer = yield* getObserver(storeId)
        const pages = yield* observer
          .pull(Option.none(), { live: false })
          .pipe(Stream.runCollectReadonlyArray, UnknownError.mapToUnknownError)
        const connected = yield* availabilityProxy.isAvailable
        return {
          connected,
          events: pages.flatMap((page) => page.batch.map(({ eventEncoded }) => eventEncoded)),
        }
      }).pipe(UnknownError.mapToUnknownError),
    setAvailability: (available) => availabilityProxy.setAvailable(available),
    serializedConfig: { _tag: 'sync-cf-ws', url: availabilityProxy.url, storeIdSuffix },
    componentVersions: {
      '@livestore/sync-cf': 'workspace',
      'cloudflare-runtime': 'wrangler-local',
    },
  } satisfies ScenarioBackend<SyncMessage.SyncMetadata>
})
