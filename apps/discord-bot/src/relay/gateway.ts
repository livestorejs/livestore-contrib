import { Discord, DiscordConfig, MemoryRateLimitStoreLive } from 'dfx'
import { DiscordWS, DiscordWSLive, JsonDiscordWSCodecLive } from 'dfx/DiscordGateway/DiscordWS'
import { MesssagingLive } from 'dfx/DiscordGateway/Messaging'
import { Shard, make as makeShard } from 'dfx/DiscordGateway/Shard'
import { ShardStateStore } from 'dfx/DiscordGateway/Shard/StateStore'
import { RateLimiterLive } from 'dfx/RateLimit'
import { Context, Deferred, Effect, Layer, Option, Redacted } from 'effect'

import { gatewayIntents } from '../discord/events.ts'
import { captureRelayMessages } from './capture.ts'
import type { RelayOutbox } from './outbox.ts'

/** Scoped Discord ingress. The action authority remains in Cloudflare. */
export const openRelayGateway = (input: {
  readonly botToken: string
  readonly guildId: string
  readonly channels: ReadonlySet<string>
  readonly outbox: RelayOutbox
  readonly onInteraction?: (payload: Discord.GatewayInteractionCreateDispatchData) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>()
    let lastHelloAt = 0
    let lastAckAt = 0
    let heartbeatInterval = 0
    const observeFrame = (frame: Discord.GatewayReceivePayload) => {
      if (frame.op === Discord.GatewayOpcodes.Hello) {
        return Effect.sync(() => {
          lastHelloAt = Date.now()
          lastAckAt = 0
          heartbeatInterval = frame.d.heartbeat_interval
        })
      }
      if (frame.op === Discord.GatewayOpcodes.HeartbeatAck) {
        return Effect.sync(() => {
          lastAckAt = Date.now()
        })
      }
      if (frame.op === Discord.GatewayOpcodes.Dispatch && frame.t === Discord.GatewayDispatchEvents.InteractionCreate) {
        return input.onInteraction?.(frame.d) ?? Effect.void
      }
      return Effect.void
    }
    const onCaptureFailure = Effect.asVoid(Deferred.succeed(failed, undefined))
    const socket = Layer.effect(
      DiscordWS,
      Effect.gen(function* () {
        return captureRelayMessages({ ...input, socket: yield* DiscordWS, onCaptureFailure, observeFrame })
      }),
    ).pipe(Layer.provide(DiscordWSLive), Layer.provide(JsonDiscordWSCodecLive))
    const store = Layer.succeed(
      ShardStateStore,
      ShardStateStore.of({
        forShard: ([id, count]) => {
          const key = `${id}-${count}`
          return {
            get: Effect.sync(() => Option.fromUndefinedOr(input.outbox.session(key))),
            set: (state) =>
              Effect.sync(() => input.outbox.saveSession(key, state)).pipe(Effect.onError(() => onCaptureFailure)),
            clear: Effect.sync(() => input.outbox.clearSession(key)).pipe(Effect.onError(() => onCaptureFailure)),
          }
        },
      }),
    )
    const context = yield* Layer.build(
      Layer.effect(Shard, makeShard).pipe(
        Layer.provide(socket),
        Layer.provide(MesssagingLive),
        Layer.provide(RateLimiterLive),
        Layer.provide(MemoryRateLimitStoreLive),
        Layer.provide(store),
        Layer.provide(
          DiscordConfig.layer({
            token: Redacted.make(input.botToken),
            gateway: { intents: gatewayIntents, identifyRateLimit: [5_000, 1] },
          }),
        ),
      ),
    )
    const shard = Context.get(context, Shard)
    const session = yield* shard.connect([0, 1])
    return {
      lifecycle: session.lifecycle,
      heartbeatHealthy: () =>
        lastAckAt >= lastHelloAt && lastAckAt > 0 && Date.now() - lastAckAt <= 2 * heartbeatInterval,
      failure: Effect.raceFirst(
        session.failure.pipe(Effect.orDie),
        Deferred.await(failed).pipe(
          Effect.andThen(Effect.die(new Error('Discord relay could not persist Gateway state'))),
        ),
      ),
    }
  })
