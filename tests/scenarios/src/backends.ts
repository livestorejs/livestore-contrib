import { randomUUID } from 'node:crypto'
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

/** Normalizes provider pagination/delivery order into the authoritative global Eventlog order. */
export const orderBackendEvents = <TEvent extends { readonly seqNum: number }>(
  events: ReadonlyArray<TEvent>,
): ReadonlyArray<TEvent> => events.toSorted((left, right) => left.seqNum - right.seqNum)

/** Backend realization owned by the runner, independently of participant placement. */
export interface ScenarioBackend<TSyncMetadata = Schema.Json> {
  readonly id: 'mock' | 'local-sync-cf' | 'cloud-sync-cf'
  readonly makeBackend: (
    args: SyncBackend.MakeBackendArgs,
  ) => Effect.Effect<SyncBackend.SyncBackend<TSyncMetadata>, UnknownError, Scope.Scope>
  readonly observe: (storeId: string) => Effect.Effect<BackendSnapshot, UnknownError, Scope.Scope>
  readonly setAvailability: (available: boolean) => Effect.Effect<void, UnknownError>
  readonly serializedConfig:
    | { readonly _tag: 'mock' }
    | {
        readonly _tag: 'sync-cf-ws'
        readonly url: string
        readonly storeIdSuffix: string
        readonly payload?: Schema.Json
      }
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
    const observer = yield* backend.makeSyncBackend

    return {
      id: 'mock',
      makeBackend: () => backend.makeSyncBackend,
      observe: () =>
        Effect.all({
          connected: SubscriptionRef.get(observer.isConnected),
          events: observer.pull(Option.none()).pipe(
            Stream.runCollect,
            Effect.map((items) =>
              orderBackendEvents([...items].flatMap((item) => item.batch.map(({ eventEncoded }) => eventEncoded))),
            ),
            Effect.mapError((cause) => (cause._tag === 'UnknownError' ? cause : new UnknownError({ cause }))),
          ),
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
          events: orderBackendEvents(pages.flatMap((page) => page.batch.map(({ eventEncoded }) => eventEncoded))),
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

export interface CloudSyncCfScenarioBackendOptions {
  readonly url: string
  readonly token: string
  readonly backendRevision: string
}

/** Connects the scenario profiles to a deployed sync-cf Worker and real SQLite Durable Object. */
export const makeCloudSyncCfScenarioBackend = (
  options: CloudSyncCfScenarioBackendOptions,
): Effect.Effect<
  ScenarioBackend<SyncMessage.SyncMetadata>,
  UnknownError,
  Scope.Scope | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const availabilityProxy = yield* makeAvailabilityProxy(options.url)
    const storeIdSuffix = `scenario-${randomUUID()}`
    const physicalStoreId = (storeId: string) => `${storeId}-${storeIdSuffix}`
    const payload = { _tag: 'scenario-cloud-auth', token: options.token } as const
    const makeWsBackend = makeWsSync({ url: availabilityProxy.url })
    const makeObserverBackend = makeWsSync({ url: options.url })
    const physicalStoreIds = new Set<string>()
    const makeBackend = (args: SyncBackend.MakeBackendArgs) => {
      const storeId = physicalStoreId(args.storeId)
      physicalStoreIds.add(storeId)
      return makeWsBackend({ ...args, storeId, payload }).pipe(
        Effect.provide(Layer.mergeAll(FetchHttpClient.layer, KeyValueStore.layerMemory)),
      )
    }
    const observers = new Map<string, SyncBackend.SyncBackend<SyncMessage.SyncMetadata>>()

    const getObserver = (storeId: string) =>
      Effect.gen(function* () {
        const existing = observers.get(storeId)
        if (existing !== undefined) return existing
        const physicalId = physicalStoreId(storeId)
        physicalStoreIds.add(physicalId)
        const observer = yield* makeObserverBackend({
          storeId: physicalId,
          clientId: 'scenario-backend-observer',
          payload,
        }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, KeyValueStore.layerMemory)))
        yield* observer.connect
        observers.set(storeId, observer)
        return observer
      })

    yield* Effect.addFinalizer(() =>
      cleanupCloudStores({ ...options, storeIds: [...physicalStoreIds] }).pipe(
        Effect.catchCause((cause) => Effect.logWarning('Failed to clean cloud scenario stores', cause)),
      ),
    )

    return {
      id: 'cloud-sync-cf',
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
            events: orderBackendEvents(pages.flatMap((page) => page.batch.map(({ eventEncoded }) => eventEncoded))),
          }
        }).pipe(UnknownError.mapToUnknownError),
      setAvailability: (available) => availabilityProxy.setAvailable(available),
      serializedConfig: { _tag: 'sync-cf-ws', url: availabilityProxy.url, storeIdSuffix, payload },
      componentVersions: {
        '@livestore/sync-cf': options.backendRevision,
        'cloudflare-runtime': 'deployed',
      },
    } satisfies ScenarioBackend<SyncMessage.SyncMetadata>
  })

const cleanupCloudStores = (args: CloudSyncCfScenarioBackendOptions & { readonly storeIds: ReadonlyArray<string> }) =>
  Effect.tryPromise({
    try: async () => {
      if (args.storeIds.length === 0) return
      const response = await fetch(new URL('/__scenario/cleanup', args.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-scenario-sync-token': args.token,
        },
        body: JSON.stringify({ storeIds: args.storeIds }),
      })
      if (response.ok === false) {
        throw new Error(`Cloud scenario cleanup failed (${response.status}): ${await response.text()}`)
      }
    },
    catch: (cause) => new UnknownError({ cause }),
  })
