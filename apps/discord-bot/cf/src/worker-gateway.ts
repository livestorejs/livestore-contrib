import { Discord, DiscordConfig, MemoryRateLimitStoreLive } from 'dfx'
import { DiscordWS, DiscordWSLive, JsonDiscordWSCodecLive } from 'dfx/DiscordGateway/DiscordWS'
import { MesssagingLive } from 'dfx/DiscordGateway/Messaging'
import { Shard, make as makeShard } from 'dfx/DiscordGateway/Shard'
import { ShardStateStore, type ShardState } from 'dfx/DiscordGateway/Shard/StateStore'
import { RateLimiterLive } from 'dfx/RateLimit'
import { Context, Deferred, Effect, Layer, Option, Queue, Redacted, Schema, Stream } from 'effect'
import { WebSocketConstructor } from 'effect/unstable/socket/Socket'

import { gatewayIntents } from '../../src/discord/events.ts'
import { DiscordMessageRef } from '../../src/threading/model.ts'

interface GatewayOwner {
  readonly isOwner: () => Effect.Effect<boolean>
  readonly renew: (ready: boolean, ackAt: number, event?: 'Ready' | 'Resumed') => Effect.Effect<number | undefined>
  readonly checkpoint: (session: ShardState | undefined) => Effect.Effect<boolean>
  readonly allowIdentify: () => Effect.Effect<boolean>
  readonly capture: (source: DiscordMessageRef) => Effect.Effect<boolean>
  readonly drain: () => Effect.Effect<void>
}

// DFX's scoped socket normally closes with 1000. Discord invalidates the session on
// that close, so use a resumable close for scoped exits without altering DFX reconnects.
const resumableSocket = (assertOwnership: () => void) =>
  Layer.succeed(WebSocketConstructor, (url, protocols) => {
    assertOwnership()
    const socket = new WebSocket(url, protocols)
    const send = socket.send.bind(socket)
    socket.send = (data) => {
      assertOwnership()
      send(data)
    }
    const close = socket.close.bind(socket)
    socket.close = (code, reason) => close(code === 1000 ? 4000 : code, reason)
    return socket
  })

interface WorkerGatewayInput {
  readonly token: string
  readonly applicationId: string
  readonly guildId: string
  readonly channels: ReadonlyArray<string>
  readonly session: ShardState | undefined
  readonly owner: GatewayOwner
  readonly until: number
  readonly expiresAt: number
}

const makeWorkerGateway = (input: WorkerGatewayInput) => {
  const failed = Deferred.makeUnsafe<void>()
  let validUntil = input.expiresAt
  const assertOwnership = () => {
    // The runtime can suspend between an RPC and the actual network write.
    if (Date.now() < validUntil) return
    validUntil = 0
    Deferred.doneUnsafe(failed, Effect.void)
    throw new Error('Gateway ownership has expired')
  }
  return Effect.gen(function* () {
    const identity = yield* Effect.promise(async (signal) => {
      const response = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
        headers: { Authorization: `Bot ${input.token}`, 'User-Agent': 'DiscordBot (https://livestore.dev, 1)' },
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      return response.ok === true ? response.json() : undefined
    })
    if (
      Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Literal(input.applicationId) }))(identity)._tag === 'None'
    ) {
      return yield* Effect.die(new Error('Gateway token does not match the configured Discord application'))
    }
    const wake = yield* Queue.sliding<void>(1)
    let state = input.session !== undefined && input.session.sessionId !== '' ? input.session : undefined
    let established = false
    let helloAt = 0
    let ackAt = 0
    let heartbeatInterval = 0
    const loseOwnership = Effect.sync(() => {
      validUntil = 0
    }).pipe(Effect.andThen(Deferred.succeed(failed, undefined)))
    const guard = (attempt: Effect.Effect<boolean>) =>
      attempt.pipe(
        Effect.timeoutOption(5_000),
        Effect.map(Option.getOrElse(() => false)),
        Effect.flatMap((ok) => (ok === true ? Effect.void : loseOwnership.pipe(Effect.andThen(Effect.never)))),
        Effect.onError(() => Effect.asVoid(loseOwnership)),
      )
    const renew = (ready: boolean, ackAt: number, event?: 'Ready' | 'Resumed') =>
      guard(
        input.owner.renew(ready, ackAt, event).pipe(
          Effect.map((expiresAt) => {
            if (expiresAt === undefined || Date.now() >= validUntil || Date.now() >= expiresAt) return false
            validUntil = Math.max(validUntil, expiresAt)
            return true
          }),
        ),
      )
    const clear = guard(input.owner.checkpoint(undefined)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          state = undefined
        }),
      ),
    )
    const store = Layer.succeed(
      ShardStateStore,
      ShardStateStore.of({
        forShard: () => ({
          get: Effect.sync(() => Option.fromUndefinedOr(state)),
          set: (next) =>
            Effect.suspend(() => {
              if (
                next.sessionId === state?.sessionId &&
                next.sequence === state.sequence &&
                next.resumeUrl === state.resumeUrl
              ) {
                return Effect.void
              }
              const snapshot = { ...next }
              return guard(input.owner.checkpoint(snapshot)).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    state = snapshot
                  }),
                ),
              )
            }),
          clear,
        }),
      }),
    )
    const socket = Layer.effect(
      DiscordWS,
      Effect.gen(function* () {
        const original = yield* DiscordWS
        return DiscordWS.of({
          connect: (options) =>
            original
              .connect({
                ...options,
                ...(state !== undefined && state.resumeUrl !== '' ? { url: state.resumeUrl } : {}),
                onConnecting: options.onConnecting.pipe(Effect.andThen(guard(input.owner.isOwner()))),
              })
              .pipe(
                Effect.map((connection) => ({
                  ...connection,
                  write: (frame) =>
                    typeof frame === 'object' && frame.op === Discord.GatewayOpcodes.Identify
                      ? guard(input.owner.allowIdentify()).pipe(Effect.andThen(connection.write(frame)))
                      : typeof frame === 'object' &&
                          (frame.op === Discord.GatewayOpcodes.Resume || frame.op === Discord.GatewayOpcodes.Heartbeat)
                        ? guard(input.owner.isOwner()).pipe(Effect.andThen(connection.write(frame)))
                        : connection.write(frame),
                  take: connection.take.pipe(
                    Effect.tap((frame) =>
                      Effect.gen(function* () {
                        if (frame.op === Discord.GatewayOpcodes.Hello) {
                          helloAt = Date.now()
                          ackAt = 0
                          heartbeatInterval = frame.d.heartbeat_interval
                        }
                        if (frame.op === Discord.GatewayOpcodes.HeartbeatAck) ackAt = Date.now()
                        if (
                          frame.op === Discord.GatewayOpcodes.Dispatch &&
                          frame.t === Discord.GatewayDispatchEvents.MessageCreate &&
                          frame.d.type === Discord.MessageType.DEFAULT &&
                          frame.d.guild_id === input.guildId &&
                          input.channels.includes(frame.d.channel_id) === true
                        ) {
                          // DFX advances its durable cursor after take completes.
                          const source = yield* Schema.decodeEffect(DiscordMessageRef)({
                            guildId: frame.d.guild_id,
                            channelId: frame.d.channel_id,
                            messageId: frame.d.id,
                          }).pipe(Effect.orDie)
                          yield* guard(input.owner.capture(source))
                          yield* Queue.offer(wake, undefined)
                        }
                      }),
                    ),
                    Effect.onError(() => Effect.asVoid(loseOwnership)),
                  ),
                })),
              ),
        })
      }),
    ).pipe(Layer.provide(DiscordWSLive), Layer.provide(JsonDiscordWSCodecLive))
    const context = yield* Layer.build(
      Layer.effect(Shard, makeShard).pipe(
        Layer.provide(socket),
        Layer.provide(MesssagingLive),
        Layer.provide(RateLimiterLive),
        Layer.provide(MemoryRateLimitStoreLive),
        Layer.provide(store),
        Layer.provide(
          DiscordConfig.layer({
            token: Redacted.make(input.token),
            gateway: { intents: gatewayIntents, identifyRateLimit: [5_000, 1] },
          }),
        ),
      ),
    )
    const session = yield* Context.get(context, Shard).connect([0, 1])
    const healthy = () => established && ackAt >= helloAt && ackAt > 0 && Date.now() - ackAt <= 2 * heartbeatInterval
    const monitor = Stream.runForEach(session.lifecycle, (event) =>
      Effect.sync(() => {
        established = event._tag === 'Ready' || event._tag === 'Resumed'
      }).pipe(
        Effect.flatMap(() =>
          renew(healthy(), ackAt, event._tag === 'Ready' || event._tag === 'Resumed' ? event._tag : undefined),
        ),
      ),
    )
    const report = Effect.suspend(() => renew(healthy(), ackAt)).pipe(Effect.delay('15 seconds'), Effect.forever)
    const drain = input.owner.drain().pipe(Effect.andThen(Queue.take(wake)), Effect.forever)
    return yield* Effect.raceFirst(
      Effect.raceFirst(session.failure, Deferred.await(failed)),
      Effect.all([monitor, report, drain], { concurrency: 'unbounded' }),
    ).pipe(Effect.asVoid)
  }).pipe(
    Effect.provide(resumableSocket(assertOwnership)),
    Effect.scoped,
    Effect.timeoutOption(Math.max(0, input.until - Date.now())),
    Effect.asVoid,
  )
}

export const runWorkerGateway = (input: WorkerGatewayInput) => Effect.suspend(() => makeWorkerGateway(input))
