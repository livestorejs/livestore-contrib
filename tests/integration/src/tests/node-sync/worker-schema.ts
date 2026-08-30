import { ShutdownChannel } from '@livestore/common/leader-thread'
import { Rpc, RpcGroup, Schema } from '@livestore/utils/effect'

import { tables } from './schema.ts'

export const StorageType = Schema.Literals(['in-memory', 'fs'])
export const AdapterType = Schema.Literals(['single-threaded', 'worker'])

export const Params = Schema.Struct({
  leaderPushBatchSize: Schema.optional(Schema.Finite),
})

export type Params = typeof Params.Type

export class InitialMessage extends Rpc.make('InitialMessage', {
  payload: {
    storeId: Schema.String,
    clientId: Schema.String,
    adapterType: AdapterType,
    storageType: StorageType,
    syncUrl: Schema.String,
    params: Params.pipe(Schema.optional),
  },
  success: Schema.Void,
  error: Schema.Never,
}) {}

export class CreateTodos extends Rpc.make('CreateTodos', {
  payload: {
    count: Schema.Finite,
    commitBatchSize: Schema.optional(Schema.Finite),
  },
  success: Schema.Void,
  error: Schema.Never,
}) {}

export class StreamTodos extends Rpc.make('StreamTodos', {
  payload: {},
  success: Schema.Array(tables.todo.rowSchema),
  error: Schema.Never,
  stream: true,
}) {}

export class OnShutdown extends Rpc.make('OnShutdown', {
  payload: {},
  success: Schema.Void,
  error: ShutdownChannel.All,
}) {}

export class WorkerRpcs extends RpcGroup.make(CreateTodos, StreamTodos, OnShutdown) {}
