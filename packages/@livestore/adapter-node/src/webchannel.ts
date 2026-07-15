import type { BroadcastChannel as NodeBroadcastChannel } from 'node:worker_threads'

import { Deferred, Effect, Exit, Queue, Schema, Scope, Stream, WebChannel } from '@livestore/utils/effect'

export const makeBroadcastChannel = <Msg, MsgEncoded>({
  channelName,
  schema,
}: {
  channelName: string
  schema: Schema.Codec<Msg, MsgEncoded>
}): Effect.Effect<WebChannel.WebChannel<Msg, Msg>, never, Scope.Scope> =>
  Effect.scopeWithCloseable((scope) =>
    Effect.gen(function* () {
      if (globalThis.BroadcastChannel === undefined) {
        yield* Effect.logWarning('BroadcastChannel is not supported in this environment. Using a NoopChannel instead.')
        return (yield* WebChannel.noopChannel()) as any as WebChannel.WebChannel<Msg, Msg>
      }

      // NOTE we're using `globalThis.BroadcastChannel` here because `BroadcastChannel`
      // from `node:worker_threads` is not yet stable in Deno
      const channel = new globalThis.BroadcastChannel(channelName) as any as NodeBroadcastChannel

      yield* Effect.addFinalizer(() =>
        Effect.try(() => {
          // NOTE not all BroadcastChannel implementations have the `unref` method
          if (typeof channel.unref === 'function') {
            channel.unref()
          }
          channel.close()
        }).pipe(Effect.ignore),
      )

      const send = (message: Msg) =>
        Effect.gen(function* () {
          const messageEncoded = yield* Schema.encodeEffect(schema)(message)
          channel.postMessage(messageEncoded)
        })

      // In Effect v4, forking a consumer is not a readiness handshake. Install the message
      // listener while constructing the channel and buffer into a scoped queue so early messages
      // are not lost before `listen` is pulled.
      const messageQueue = yield* Effect.acquireRelease(Queue.unbounded<unknown>(), Queue.shutdown)
      channel.onmessage = (event: any) => {
        Queue.offerUnsafe(messageQueue, event.data)
      }

      const listen = Stream.fromQueue(messageQueue).pipe(Stream.map((data) => Schema.decodeResult(schema)(data)))

      const closedDeferred = yield* Effect.acquireRelease(Deferred.make<void>(), Deferred.done(Exit.void))
      const supportsTransferables = false

      return {
        [WebChannel.WebChannelSymbol]: WebChannel.WebChannelSymbol,
        send,
        listen,
        closedDeferred,
        schema: { listen: schema, send: schema },
        supportsTransferables,
        shutdown: Scope.close(scope, Exit.void),
      }
    }).pipe(Effect.withSpan(`WebChannel:broadcastChannel(${channelName})`)),
  )
