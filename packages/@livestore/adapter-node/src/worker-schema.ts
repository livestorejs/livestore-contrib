import {
  BootStatus,
  Devtools,
  MigrationsReport,
  RejectedPushError,
  SyncBackend,
  SyncState,
  UnknownError,
} from '@livestore/common'
import { StreamEventsOptionsFields } from '@livestore/common/leader-thread'
import { EventSequenceNumber, LiveStoreEvent } from '@livestore/common/schema'
import { Rpc, RpcGroup, Schema, Transferable } from '@livestore/utils/effect'

export const WorkerArgv = Schema.fromJsonString(
  Schema.Struct({
    clientId: Schema.String,
    storeId: Schema.String,
    sessionId: Schema.String,
    extraArgs: Schema.optional(Schema.Json),
  }),
)

export const StorageTypeInMemory = Schema.Struct({
  type: Schema.Literal('in-memory'),
  /**
   * Only works with single-threaded leader thread for now.
   * Should be mostly used for testing.
   */
  importSnapshot: Schema.optional(Transferable.Uint8Array),
})

export type StorageTypeInMemory = typeof StorageTypeInMemory.Type

export const StorageTypeFs = Schema.Struct({
  type: Schema.Literal('fs'),
  /**
   * Where to store the database files
   *
   * @default Current working directory
   */
  baseDirectory: Schema.optional(Schema.String),
})

export type StorageTypeFs = typeof StorageTypeFs.Type

export const StorageType = Schema.Union([StorageTypeInMemory, StorageTypeFs])
export type StorageType = typeof StorageType.Type
export type StorageTypeEncoded = typeof StorageType.Encoded

// export const SyncBackendOptionsWebsocket = Schema.Struct({
//   type: Schema.Literal('websocket'),
//   url: Schema.String,
//   storeId: Schema.String,
// })

// export const SyncBackendOptions = Schema.Union(SyncBackendOptionsWebsocket)
export const SyncBackendOptions = Schema.Record(Schema.String, Schema.Json)
export type SyncBackendOptions = Record<string, Schema.Json>

export class LeaderWorkerOuterInitialMessage extends Rpc.make('InitialMessage', {
  payload: { port: Transferable.MessagePort },
  success: Schema.Void,
  error: Schema.Never,
}) {}

export class LeaderWorkerOuterRpcs extends RpcGroup.make(LeaderWorkerOuterInitialMessage) {}

export class LeaderWorkerInnerInitialMessage extends Rpc.make('InitialMessage', {
  payload: {
    storeId: Schema.String,
    clientId: Schema.String,
    storage: StorageType,
    syncPayloadEncoded: Schema.UndefinedOr(Schema.Json),
    devtools: Schema.Union([
      Schema.Struct({
        enabled: Schema.Literal(true),
        schemaPath: Schema.String,
        port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
        host: Schema.String,
        schemaAlias: Schema.String,
        useExistingDevtoolsServer: Schema.Boolean,
      }),
      Schema.Struct({ enabled: Schema.Literal(false) }),
    ]),
  },
  success: Schema.Void,
  error: UnknownError,
}) {}

export type LeaderWorkerInnerInitialMessagePayload = typeof LeaderWorkerInnerInitialMessage.payloadSchema.Type

export class LeaderWorkerInnerBootStatusStream extends Rpc.make('BootStatusStream', {
  payload: {},
  success: BootStatus,
  error: Schema.Never,
  stream: true,
}) {}

export class LeaderWorkerInnerPullStream extends Rpc.make('PullStream', {
  payload: {
    cursor: Schema.toType(EventSequenceNumber.Client.Composite),
  },
  success: Schema.Struct({
    payload: SyncState.PayloadUpstream,
  }),
  error: Schema.Never,
  stream: true,
}) {}

export class LeaderWorkerInnerStreamEvents extends Rpc.make('StreamEvents', {
  payload: StreamEventsOptionsFields,
  success: LiveStoreEvent.Client.Encoded,
  error: Schema.Never,
  stream: true,
}) {}

export class LeaderWorkerInnerPushToLeader extends Rpc.make('PushToLeader', {
  payload: {
    batch: Schema.Array(Schema.toType(LiveStoreEvent.Client.Encoded)),
  },
  success: Schema.Void,
  error: RejectedPushError,
}) {}

export class LeaderWorkerInnerExport extends Rpc.make('Export', {
  payload: {},
  success: Transferable.Uint8Array,
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerGetRecreateSnapshot extends Rpc.make('GetRecreateSnapshot', {
  payload: {},
  success: Schema.Struct({
    snapshot: Transferable.Uint8Array,
    migrationsReport: MigrationsReport,
  }),
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerExportEventlog extends Rpc.make('ExportEventlog', {
  payload: {},
  success: Transferable.Uint8Array,
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerGetLeaderHead extends Rpc.make('GetLeaderHead', {
  payload: {},
  success: Schema.toType(EventSequenceNumber.Client.Composite),
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerGetLeaderSyncState extends Rpc.make('GetLeaderSyncState', {
  payload: {},
  success: SyncState.SyncState,
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerSyncStateStream extends Rpc.make('SyncStateStream', {
  payload: {},
  success: SyncState.SyncState,
  error: Schema.Never,
  stream: true,
}) {}

export class LeaderWorkerInnerGetNetworkStatus extends Rpc.make('GetNetworkStatus', {
  payload: {},
  success: SyncBackend.NetworkStatus,
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerNetworkStatusStream extends Rpc.make('NetworkStatusStream', {
  payload: {},
  success: SyncBackend.NetworkStatus,
  error: Schema.Never,
  stream: true,
}) {}

export class LeaderWorkerInnerShutdown extends Rpc.make('Shutdown', {
  payload: {},
  success: Schema.Void,
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerExtraDevtoolsMessage extends Rpc.make('ExtraDevtoolsMessage', {
  payload: {
    message: Devtools.Leader.MessageToApp,
  },
  success: Schema.Void,
  error: Schema.Never,
}) {}

export class LeaderWorkerInnerRpcs extends RpcGroup.make(
  LeaderWorkerInnerBootStatusStream,
  LeaderWorkerInnerPullStream,
  LeaderWorkerInnerStreamEvents,
  LeaderWorkerInnerPushToLeader,
  LeaderWorkerInnerExport,
  LeaderWorkerInnerGetRecreateSnapshot,
  LeaderWorkerInnerExportEventlog,
  LeaderWorkerInnerGetLeaderHead,
  LeaderWorkerInnerGetLeaderSyncState,
  LeaderWorkerInnerSyncStateStream,
  LeaderWorkerInnerGetNetworkStatus,
  LeaderWorkerInnerNetworkStatusStream,
  LeaderWorkerInnerShutdown,
  LeaderWorkerInnerExtraDevtoolsMessage,
) {}
