import type { WebAdapterOptions } from '@livestore/adapter-web'
import type {
  DebugInfo,
  PreparedBindValues,
  ResetMode,
  SyncState,
  UnknownError,
} from '@livestore/common'
import { Devtools, liveStoreVersion } from '@livestore/common'
import type { LiveStoreEvent } from '@livestore/common/schema'
import { devtoolsProtocolVersion } from '@livestore/devtools-common'
import type { ReactiveGraph } from '@livestore/livestore/internal'
import { casesHandled } from '@livestore/utils'
import type { Cause, HashSet, Scope, Subscribable } from '@livestore/utils/effect'
import { Duration, Effect, Option, Schema, Stream, SubscriptionRef } from '@livestore/utils/effect'
import { nanoid } from '@livestore/utils/nanoid'

import type { DevtoolsBridge } from './adapter-bridges/devtools-bridge.js'
import { makeNodeDevtoolsBridge } from './adapter-bridges/node-bridge.js'
import { makeWebBrowserExtensionDevtoolsBridge } from './adapter-bridges/web-browser-extension-bridge.js'
import { makeWebDevtoolsBridge } from './adapter-bridges/web-shared-worker-bridge.js'
import type { MockMode } from './root-context.js'

export const makeApi = ({
  sharedWorker,
  mode,
  triggerReload,
}: {
  sharedWorker: WebAdapterOptions['sharedWorker']
  mode: Devtools.DevtoolsMode | MockMode
  triggerReload: () => void
}): Effect.Effect<DevtoolsApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (mode._tag === 'mock') {
      return mode.api
    }

    const bridge = yield* makeBridge({ sharedWorker, mode })
    return yield* makeDevtoolsApiFactory({ bridge, triggerReload })
  }).pipe(Effect.withSpan('@livestore/devtools-react:makeApi'), Effect.orDie)

const makeBridge = ({
  sharedWorker,
  mode,
}: {
  sharedWorker: WebAdapterOptions['sharedWorker']
  mode: Devtools.DevtoolsMode
}) => {
  switch (mode._tag) {
    case 'browser-extension': {
      return makeWebBrowserExtensionDevtoolsBridge
    }
    case 'node': {
      return makeNodeDevtoolsBridge({ url: mode.url })
    }
    case 'web': {
      return makeWebDevtoolsBridge({ sharedWorker })
    }
    default: {
      return casesHandled(mode)
    }
  }
}

const ConnectionStatus = Schema.Union([
  Schema.TaggedStruct('connected', {}),
  Schema.TaggedStruct('disconnected', {
    leader: Schema.Boolean,
    clientSession: Schema.Boolean,
  }),
])

type ConnectionStatus = typeof ConnectionStatus.Type

/**
 * Represents a DevTools protocol mismatch between DevTools and the app.
 */
export const VersionMismatchStatus = Schema.Union([
  Schema.TaggedStruct('compatible', {}),
  Schema.TaggedStruct('mismatch', {
    /** The DevTools package/artifact version, kept for display and debugging. */
    devtoolsVersion: Schema.String,
    /** The app package version, kept for display and debugging. */
    appVersion: Schema.String,
    /** The protocol version sent by DevTools. */
    devtoolsProtocolVersion: Schema.Finite,
    /** The protocol version reported by the app when available. */
    appDevtoolsProtocolVersion: Schema.optional(Schema.Finite),
  }),
])

export type VersionMismatchStatus = typeof VersionMismatchStatus.Type

export const makeDevtoolsApiFactory = ({
  bridge,
  triggerReload,
}: {
  bridge: DevtoolsBridge
  triggerReload: () => void
}): Effect.Effect<DevtoolsApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const connect: DevtoolsApi['connect'] = (clientInfo) =>
      Effect.gen(function* () {
        yield* bridge.connect(clientInfo)

        const { storeId, clientId, sessionId } = clientInfo

        /**
         * Note on re-connect handling:
         * - The current implementation of devtools-reconnect handling is rather crude.
         * - We're listening for the `Disconnect` message from the client session and trigger a full page reload.
         *   - Which is triggered via `beforeunload` or similar.
         * - Give the client might not be ready yet to receive our channel request, we're retrying the channel request.
         *   - We need to make sure we close the existing channel if it exists upon retry.
         */
        const webchannels = yield* Effect.all(
          {
            clientSession: bridge.meshNode
              .makeChannel({
                target: Devtools.makeNodeName.client.session({
                  storeId,
                  clientId,
                  sessionId,
                }),
                schema: {
                  listen: Devtools.ClientSession.MessageFromApp,
                  send: Devtools.ClientSession.MessageToApp,
                },
                channelName: Devtools.makeChannelName.devtoolsClientSession({
                  storeId,
                  clientId,
                  sessionId,
                }),
                mode: bridge.meshChannelMode,
                closeExisting: true,
              })
              .pipe(Effect.timeout(500), Effect.retry({}), Effect.orDie),
            leader: bridge.meshNode
              .makeChannel({
                target: Devtools.makeNodeName.client.leader({
                  storeId,
                  clientId,
                }),
                schema: {
                  listen: Devtools.Leader.MessageFromApp,
                  send: Devtools.Leader.MessageToApp,
                },
                channelName: Devtools.makeChannelName.devtoolsClientLeader({
                  storeId,
                  clientId,
                  sessionId,
                }),
                mode: bridge.meshChannelMode,
                closeExisting: true,
              })
              .pipe(Effect.timeout(500), Effect.retry({}), Effect.orDie),
          },
          { concurrency: 'unbounded' },
        )

        const leaderStatus = yield* SubscriptionRef.make<'connected' | 'disconnected'>('connected')
        const clientSessionStatus = yield* SubscriptionRef.make<'connected' | 'disconnected'>(
          'connected',
        )
        const versionMismatchStatus = yield* SubscriptionRef.make<VersionMismatchStatus>({
          _tag: 'compatible',
        })

        const sendToClient = (
          msg: Devtools.Leader.MessageToApp | Devtools.ClientSession.MessageToApp,
        ) =>
          Effect.gen(function* () {
            // NOTE it's possible that a message is for both the coordinator and the store (e.g. Disconnect)
            if (Schema.is(Devtools.Leader.MessageToApp)(msg)) {
              yield* webchannels.leader.send(msg)
            } else {
              yield* webchannels.clientSession.send(msg)
            }
          }).pipe(Effect.withSpan('sendToClient'), Effect.orDie)

        const responseStream_: Stream.Stream<
          Devtools.Leader.MessageFromApp | Devtools.ClientSession.MessageFromApp
        > = Stream.merge(
          webchannels.leader.listen.pipe(Stream.mapEffect(Effect.fromResult)),
          webchannels.clientSession.listen.pipe(Stream.mapEffect(Effect.fromResult)),
        ).pipe(
          // Only for debugging
          // Stream.tapLogWithLabel('devtools-api:responseStream'),
          Stream.orDie,
        )

        // TODO improve implementation to no longer need the broadcasting/message duplication
        const responseStream = yield* responseStream_.pipe(
          Stream.broadcast({ capacity: 10 }),
          Effect.orDie,
        )

        // const sendToAppHost: DevtoolsBridge['sendToAppHost'] = (msg) =>
        //   isDisconnected ? Effect.void : sendToAppHost_(msg)

        // const sendToAppHost: DevtoolsBridge['sendToAppHost'] = (msg) =>
        //   // Effect.suspend(() => (isDisconnected ? Effect.void : sendToAppHost_(msg)))
        //   Effect.suspend(() => {
        //     return isDisconnected ? Effect.void : sendToAppHost_(msg)
        //   })

        // const runRequest_ = <TReq extends Devtools.Leader.MessageToApp>(
        //   payload: TReq,
        // ): TReq extends Schema.WithResult<
        //   infer Success,
        //   infer _SuccessEncoded,
        //   infer Failure,
        //   infer _FailureEncoded,
        //   infer ResultR
        // >
        //   ? Effect.Effect<Success, Exclude<Failure, UnknownError>, ResultR>
        //   : never =>
        //   Effect.suspend(() => {
        //     const requestId = nanoid(10)

        //     return responseStream.pipe(
        //       Stream.onStart(
        //         webchannels.leader.send(
        //           Devtools.Leader.EnvelopeToApp.make({ payload: payload as any, requestId, clientId, liveStoreVersion }),
        //         ),
        //       ),
        //       Stream.filter(Schema.is(Devtools.Leader.EnvelopeFromApp)),
        //       Stream.filter((_: any) => _.requestId === requestId),
        //       Stream.runHead,
        //       Effect.map((_) => Option.getOrThrow(_)),
        //     )
        //   }) as any

        // const res = runRequest_(Devtools.ResetAllData.make({ liveStoreVersion, mode: 'all-data', requestId: nanoid() }))
        // const res2 = runRequest_(Devtools.DatabaseFileInfo_.make({ liveStoreVersion, requestId: nanoid() }))

        const runRequest = <
          TagRes extends string,
          Res extends Schema.Struct.Fields,
          TagReq extends string,
          Req extends Schema.Struct.Fields,
        >(
          responseSchema: Schema.TaggedStruct<TagRes, Res>,
          requestSchema: Schema.TaggedStruct<TagReq, Req>,
          reqPayload: Omit<
            Schema.TaggedStruct<TagReq, Req>['Type'],
            'requestId' | 'clientId' | 'sessionId' | '_tag' | 'liveStoreVersion'
          >,
        ): Effect.Effect<Schema.TaggedStruct<TagRes, Res>['Type']> =>
          Effect.suspend(() => {
            const requestId = nanoid(10)

            return responseStream.pipe(
              Stream.onStart(
                sendToClient(
                  requestSchema.make({
                    ...reqPayload,
                    requestId,
                    clientId,
                    sessionId,
                    liveStoreVersion,
                  } as any) as any,
                ),
              ),
              Stream.filter(Schema.is(responseSchema)),
              Stream.filter(
                (response) => hasRequestId(response) && response.requestId === requestId,
              ),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            )
          })

        const runRequest2 = <TSchema extends Devtools.LeaderReqResSchema<string, any, any, any>>(
          schema: TSchema,
          reqPayload: Omit<
            TSchema['Request']['Type'],
            'requestId' | 'clientId' | 'sessionId' | '_tag' | 'liveStoreVersion'
          >,
        ): Effect.Effect<TSchema['Success']['Type'], TSchema['Error']['Type'], never> =>
          Effect.suspend(() => {
            const requestId = nanoid(10)

            return responseStream.pipe(
              Stream.onStart(
                sendToClient(
                  schema.Request.make({
                    ...reqPayload,
                    requestId,
                    clientId,
                    sessionId,
                    liveStoreVersion,
                  } as any) as any,
                ),
              ),
              Stream.filter(Schema.is(schema.Response)),
              Stream.filter((_: any) => _.requestId === requestId),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
              Effect.andThen((_) =>
                Schema.is(schema.Success)(_) ? Effect.succeed(_) : Effect.fail(_),
              ),
            )
          })

        const runStream = <
          TagRes extends string,
          Res extends Schema.Struct.Fields,
          TagSub extends string,
          Sub extends Schema.Struct.Fields,
          TagUnsub extends string,
          Unsub extends Schema.Struct.Fields,
        >(
          resSchema: Schema.TaggedStruct<TagRes, Res>,
          subscribeSchema: Schema.TaggedStruct<TagSub, Sub>,
          subscribeReqPayload: Omit<
            Schema.TaggedStruct<TagSub, Sub>['Type'],
            'requestId' | 'clientId' | 'sessionId' | '_tag' | 'liveStoreVersion' | 'subscriptionId'
          >,
          unsubscribeSchema: Schema.TaggedStruct<TagUnsub, Unsub>,
        ): Stream.Stream<Schema.TaggedStruct<TagRes, Res>['Type']> =>
          Stream.suspend(() => {
            const subscriptionId = nanoid(10)

            // sendToAppHost(
            //   subscribeSchema.make({ ...subscribeReqPayload, requestId, clientId, sessionId, liveStoreVersion } as any) as any,
            // ).pipe(Effect.tapCauseLogPretty, Effect.delay(100), Effect.runFork)

            return responseStream.pipe(
              Stream.onStart(
                sendToClient(
                  subscribeSchema.make({
                    ...subscribeReqPayload,
                    subscriptionId,
                    requestId: nanoid(10),
                    clientId,
                    sessionId,
                    liveStoreVersion,
                  } as any) as any,
                ),
              ),
              Stream.filter(Schema.is(resSchema)),
              Stream.filter((_: any) => _.subscriptionId === subscriptionId),
              Stream.ensuring(
                sendToClient(
                  unsubscribeSchema.make({
                    subscriptionId,
                    requestId: nanoid(10),
                    clientId,
                    sessionId,
                    liveStoreVersion,
                  } as any) as any,
                ),
              ),
            ) as any
          })

        /**
         * Runs a ping-pong loop that sends periodic pings and handles Pong/VersionMismatch responses.
         * Updates the connection status and detects version mismatches.
         */
        const runPingPong = <
          TPing extends Devtools.Leader.MessageToApp | Devtools.ClientSession.MessageToApp,
          TPong extends { _tag: string },
          TVersionMismatch extends { _tag: string; receivedVersion: string; appVersion: string },
        >(options: {
          makePing: () => TPing
          pongSchema: Schema.Schema<TPong>
          versionMismatchSchema: Schema.Schema<TVersionMismatch>
          statusRef: SubscriptionRef.SubscriptionRef<'connected' | 'disconnected'>
          spanName: string
        }) =>
          Effect.gen(function* () {
            // Keep the heartbeat request fresh for every repeat. The app deduplicates request ids, so
            // reusing one Ping would make the second heartbeat look like an already-handled request.
            const ping = options.makePing()
            const maybeResponse = yield* responseStream.pipe(
              Stream.onStart(sendToClient(ping)),
              Stream.filter(
                Schema.is(Schema.Union([options.pongSchema, options.versionMismatchSchema])),
              ),
              Stream.take(1),
              Stream.runHead,
            )
            if (Option.isNone(maybeResponse)) return
            const response = maybeResponse.value
            if ('receivedVersion' in response && 'appVersion' in response) {
              const receivedDevtoolsProtocolVersion =
                'receivedDevtoolsProtocolVersion' in response &&
                typeof response.receivedDevtoolsProtocolVersion === 'number'
                  ? response.receivedDevtoolsProtocolVersion
                  : devtoolsProtocolVersion
              const appDevtoolsProtocolVersion =
                'appDevtoolsProtocolVersion' in response &&
                typeof response.appDevtoolsProtocolVersion === 'number'
                  ? response.appDevtoolsProtocolVersion
                  : undefined
              const nextVersionMismatch: VersionMismatchStatus = {
                _tag: 'mismatch',
                devtoolsVersion: response.receivedVersion,
                appVersion: response.appVersion,
                devtoolsProtocolVersion: receivedDevtoolsProtocolVersion,
                ...(appDevtoolsProtocolVersion === undefined ? {} : { appDevtoolsProtocolVersion }),
              }
              yield* SubscriptionRef.set(versionMismatchStatus, {
                ...nextVersionMismatch,
              })
              yield* Effect.logWarning(
                `DevTools protocol mismatch: DevTools protocol ${receivedDevtoolsProtocolVersion}, App protocol ${
                  appDevtoolsProtocolVersion ?? 'unknown'
                }`,
              )
              return
            }
            yield* SubscriptionRef.set(options.statusRef, 'connected')
            yield* Effect.sleep(Duration.seconds(5))
          }).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag('TimeoutError', () =>
              SubscriptionRef.set(options.statusRef, 'disconnected'),
            ),
            Effect.forever,
            Effect.tapCauseLogPretty,
            Effect.withSpan(options.spanName),
            Effect.forkScoped,
          )

        yield* runPingPong({
          makePing: () =>
            Devtools.Leader.Ping.make({
              requestId: nanoid(10),
              clientId,
              liveStoreVersion,
              devtoolsProtocolVersion,
            }),
          pongSchema: Devtools.Leader.Pong,
          versionMismatchSchema: Devtools.Leader.VersionMismatch,
          statusRef: leaderStatus,
          spanName: '@livestore/devtools-react:api:leader-ping-pong',
        })

        yield* runPingPong({
          makePing: () =>
            Devtools.ClientSession.Ping.make({
              requestId: nanoid(10),
              clientId,
              sessionId,
              liveStoreVersion,
              devtoolsProtocolVersion,
            }),
          pongSchema: Devtools.ClientSession.Pong,
          versionMismatchSchema: Devtools.ClientSession.VersionMismatch,
          statusRef: clientSessionStatus,
          spanName: '@livestore/devtools-react:api:client-session-ping-pong',
        })

        // See above note on re-connect handling
        yield* responseStream.pipe(
          Stream.filter(Schema.is(Devtools.ClientSession.Disconnect)),
          Stream.filter((_) => _.clientId === clientId && _.sessionId === sessionId),
          Stream.take(1),
          Stream.runDrain,
          Effect.tapSync(() => triggerReload()),
          Effect.tapCauseLogPretty,
          Effect.withSpan('@livestore/devtools-react:api:onDisconnect'),
          Effect.forkScoped,
        )

        return {
          clientInfo,
          // TODO
          isLeader: true,
          snapshot: runRequest(Devtools.Leader.SnapshotRes, Devtools.Leader.SnapshotReq, {}).pipe(
            Effect.map((_) => _.snapshot),
            Effect.timeout(Duration.seconds(5)),
            Effect.withSpan('@livestore/devtools-react:api:snapshot'),
          ),
          loadDatabaseFile: (data) =>
            runRequest2(Devtools.Leader.LoadDatabaseFile, { data }).pipe(
              Effect.timeout(Duration.minutes(5)),
              Effect.withSpan('@livestore/devtools-react:api:loadDatabaseFile'),
            ),
          eventlog: runRequest(Devtools.Leader.EventlogRes, Devtools.Leader.EventlogReq, {}).pipe(
            Effect.map((_) => _.eventlog),
            Effect.timeout(Duration.seconds(5)),
            Effect.withSpan('@livestore/devtools-react:api:eventlog'),
          ),
          debugInfo: runRequest(
            Devtools.ClientSession.DebugInfoRes,
            Devtools.ClientSession.DebugInfoReq,
            {},
          ).pipe(
            Effect.map((_) => _.debugInfo),
            Effect.timeout(Duration.seconds(5)),
            Effect.withSpan('@livestore/devtools-react:api:debugInfo'),
          ),
          debugInfoHistory: runStream(
            Devtools.ClientSession.DebugInfoHistoryRes,
            Devtools.ClientSession.DebugInfoHistorySubscribe,
            {},
            Devtools.ClientSession.DebugInfoHistoryUnsubscribe,
          ).pipe(
            Stream.map((_) => _.debugInfoHistory),
            Stream.flattenIterable,
            Stream.withSpan('@livestore/devtools-react:api:debugInfoHistory'),
          ),
          debugInfoReset: runRequest(
            Devtools.ClientSession.DebugInfoResetRes,
            Devtools.ClientSession.DebugInfoResetReq,
            {},
          ).pipe(
            Effect.asVoid,
            Effect.timeout(Duration.seconds(5)),
            Effect.withSpan('@livestore/devtools-react:api:debugInfoReset'),
          ),
          debugInfoRerunQuery: (args) =>
            runRequest(
              Devtools.ClientSession.DebugInfoRerunQueryRes,
              Devtools.ClientSession.DebugInfoRerunQueryReq,
              args,
            ).pipe(
              Effect.asVoid,
              Effect.timeout(Duration.seconds(5)),
              Effect.withSpan('@livestore/devtools-react:api:debugInfoRerunQuery'),
            ),
          signalSnapshots: () =>
            runStream(
              Devtools.ClientSession.ReactivityGraphRes,
              Devtools.ClientSession.ReactivityGraphSubscribe,
              { includeResults: true },
              Devtools.ClientSession.ReactivityGraphUnsubscribe,
            ).pipe(
              Stream.map((_) => _.reactivityGraph),
              Stream.withSpan('@livestore/devtools-react:api:signalSnapshots'),
            ),
          liveQueries: () =>
            runStream(
              Devtools.ClientSession.LiveQueriesRes,
              Devtools.ClientSession.LiveQueriesSubscribe,
              {},
              Devtools.ClientSession.LiveQueriesUnsubscribe,
            ).pipe(
              Stream.map((_) => _.liveQueries),
              Stream.withSpan('@livestore/devtools-react:api:liveQueries'),
            ),
          syncPull: responseStream.pipe(
            Stream.filter(Schema.is(Devtools.Leader.SyncPull)),
            Stream.withSpan('@livestore/devtools-react:api:syncPull'),
          ),
          resetAllData: (mode: ResetMode) =>
            runRequest2(Devtools.Leader.ResetAllData, { mode }).pipe(
              Effect.asVoid,
              Effect.timeout(Duration.seconds(5)),
              Effect.withSpan('@livestore/devtools-react:api:resetAllData'),
            ),
          databaseFileInfo: runRequest(
            Devtools.Leader.DatabaseFileInfoRes,
            Devtools.Leader.DatabaseFileInfoReq,
            {},
          ).pipe(Effect.withSpan('@livestore/devtools-react:api:databaseFileInfo')),
          disconnected: sendToClient(
            Devtools.ClientSession.Disconnect.make({
              clientId,
              sessionId,
              liveStoreVersion,
            }),
          ).pipe(Effect.withSpan('@livestore/devtools-react:api:disconnected')),
          status: Stream.zipLatest(
            SubscriptionRef.changes(leaderStatus),
            SubscriptionRef.changes(clientSessionStatus),
          ).pipe(
            Stream.map(
              ([leader, clientSession]): ConnectionStatus =>
                leader === 'connected' && clientSession === 'connected'
                  ? { _tag: 'connected' }
                  : {
                      _tag: 'disconnected',
                      leader: leader === 'connected',
                      clientSession: clientSession === 'connected',
                    },
            ),
            Stream.skipRepeated(Schema.toEquivalence(ConnectionStatus)),
            Stream.tap((status) => Effect.logDebug('status', status)),
          ),
          syncingInfo: runRequest(
            Devtools.Leader.SyncingInfoRes,
            Devtools.Leader.SyncingInfoReq,
            {},
          ).pipe(
            Effect.map((_) => _.syncingInfo),
            Effect.withSpan('@livestore/devtools-react:api:syncingInfo'),
          ),
          syncHistory: runStream(
            Devtools.Leader.SyncHistoryRes,
            Devtools.Leader.SyncHistorySubscribe,
            {},
            Devtools.Leader.SyncHistoryUnsubscribe,
          ).pipe(Stream.withSpan('@livestore/devtools-react:api:syncHistory')),
          syncHeadLeader: runStream(
            Devtools.Leader.SyncHeadRes,
            Devtools.Leader.SyncHeadSubscribe,
            {},
            Devtools.Leader.SyncHeadUnsubscribe,
          ).pipe(Stream.withSpan('@livestore/devtools-react:api:syncHeadLeader')),
          syncHeadClientSession: runStream(
            Devtools.ClientSession.SyncHeadRes,
            Devtools.ClientSession.SyncHeadSubscribe,
            {},
            Devtools.ClientSession.SyncHeadUnsubscribe,
          ).pipe(Stream.withSpan('@livestore/devtools-react:api:syncHeadClientSession')),
          setSyncLatch: (closeLatch: boolean) =>
            runRequest2(Devtools.Leader.SetSyncLatch, { closeLatch }).pipe(
              Effect.withSpan('@livestore/devtools-react:api:setSyncLatch'),
            ),
          networkStatus: runStream(
            Devtools.Leader.NetworkStatusRes,
            Devtools.Leader.NetworkStatusSubscribe,
            {},
            Devtools.Leader.NetworkStatusUnsubscribe,
          ).pipe(
            Stream.map((_) => _.networkStatus),
            Stream.withSpan('@livestore/devtools-react:api:networkStatus'),
          ),
          copyToClipboard: bridge.copyToClipboard ?? defaultCopyToClipboard,
          sendEscapeKey: bridge.sendEscapeKey ?? Effect.void,
          commitEvent: (eventEncoded) =>
            runRequest(Devtools.Leader.CommitEventRes, Devtools.Leader.CommitEventReq, {
              eventEncoded,
            }).pipe(Effect.withSpan('@livestore/devtools-react:api:commitEvent')),
          versionMismatch: SubscriptionRef.changes(versionMismatchStatus).pipe(
            Stream.skipRepeated(Schema.toEquivalence(VersionMismatchStatus)),
          ),
        } satisfies DevtoolsApiSession
      })

    const { clientSessions, copyToClipboard, sendEscapeKey } = bridge

    return {
      connect,
      clientSessions,
      copyToClipboard: copyToClipboard ?? defaultCopyToClipboard,
      sendEscapeKey: sendEscapeKey ?? Effect.void,
    } satisfies DevtoolsApi
  })

const defaultCopyToClipboard = (text: string) =>
  Effect.sync(() => {
    navigator.clipboard.writeText(text)
  })

const hasRequestId = (value: unknown): value is { readonly requestId: string } =>
  typeof value === 'object' &&
  value !== null &&
  'requestId' in value &&
  typeof value.requestId === 'string'

export type DevtoolsApi = {
  connect: (
    clientInfo: Devtools.SessionInfo.SessionInfo,
  ) => Effect.Effect<DevtoolsApiSession, UnknownError, Scope.Scope>
  clientSessions: Subscribable.Subscribable<HashSet.HashSet<Devtools.SessionInfo.SessionInfo>>
  copyToClipboard: (text: string) => Effect.Effect<void>
  sendEscapeKey: Effect.Effect<void>
}

export type DevtoolsApiSession = {
  clientInfo: Devtools.SessionInfo.SessionInfo
  isLeader: boolean
  snapshot: Effect.Effect<Uint8Array<ArrayBuffer>, Cause.TimeoutError, never>
  eventlog: Effect.Effect<Uint8Array<ArrayBuffer>, Cause.TimeoutError, never>
  loadDatabaseFile: (
    data: Uint8Array<ArrayBuffer>,
  ) => Effect.Effect<
    void,
    typeof Devtools.Leader.LoadDatabaseFile.Error.Type | Cause.TimeoutError,
    never
  >
  signalSnapshots: () => Stream.Stream<ReactiveGraph.ReactiveGraphSnapshot>
  liveQueries: () => Stream.Stream<
    ReadonlyArray<typeof Devtools.ClientSession.SerializedLiveQuery.Type>
  >
  debugInfo: Effect.Effect<DebugInfo, Cause.TimeoutError, never>
  debugInfoHistory: Stream.Stream<DebugInfo>
  debugInfoReset: Effect.Effect<void, Cause.TimeoutError, never>
  setSyncLatch: (closeLatch: boolean) => Effect.Effect<void, Cause.TimeoutError, never>
  debugInfoRerunQuery: (args: {
    queryStr: string
    bindValues: PreparedBindValues | undefined
    queriedTables: ReadonlySet<string>
  }) => Effect.Effect<void, Cause.TimeoutError, never>
  syncPull: Stream.Stream<{ payload: typeof SyncState.PayloadUpstream.Type }>
  resetAllData: (mode: ResetMode) => Effect.Effect<void, Cause.TimeoutError, never>
  databaseFileInfo: Effect.Effect<
    typeof Devtools.Leader.DatabaseFileInfoRes.Type,
    Cause.TimeoutError,
    never
  >
  disconnected: Effect.Effect<void>
  status: Stream.Stream<ConnectionStatus>
  syncingInfo: Effect.Effect<typeof Devtools.Leader.SyncingInfo.Type, Cause.TimeoutError, never>
  syncHistory: Stream.Stream<{
    eventEncoded: LiveStoreEvent.Global.Encoded
    metadata: Option.Option<any>
  }>
  syncHeadLeader: Stream.Stream<typeof Devtools.Leader.SyncHeadRes.Type>
  syncHeadClientSession: Stream.Stream<typeof Devtools.ClientSession.SyncHeadRes.Type>
  networkStatus: Stream.Stream<Devtools.NetworkStatus>
  copyToClipboard: (text: string) => Effect.Effect<void>
  sendEscapeKey: Effect.Effect<void>
  commitEvent: (eventEncoded: LiveStoreEvent.Input.Encoded) => Effect.Effect<void>
  /** Stream that emits version mismatch status when the app's LiveStore version differs from DevTools' */
  versionMismatch: Stream.Stream<VersionMismatchStatus>
}
