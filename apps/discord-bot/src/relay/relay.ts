import type { Discord } from 'dfx'
import { Effect, Queue, Stream } from 'effect'

import { forwardRelayMessage, sendRelayJson } from './forward.ts'
import { openRelayGateway } from './gateway.ts'
import type { RelayOutbox } from './outbox.ts'

/** Run the relay only after the caller has acquired the stage's Gateway authority. */
export const runGatewayRelay = (input: {
  readonly botToken: string
  readonly guildId: string
  readonly channels: ReadonlySet<string>
  readonly endpoint: URL
  readonly token: string
  readonly outbox: RelayOutbox
}) =>
  Effect.gen(function* () {
    const owner = crypto.randomUUID()
    const drain = (untilCapacity: boolean) =>
      Effect.gen(function* () {
        while (untilCapacity === false || input.outbox.hasCapacity() === false) {
          const outcome = yield* Effect.promise((signal) =>
            forwardRelayMessage({
              endpoint: endpoint('/gateway/messages'),
              token: input.token,
              owner,
              outbox: input.outbox,
              signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            }),
          )
          if (outcome === 'empty') yield* Effect.sleep(250)
          if (outcome === 'retry') yield* Effect.logWarning('Discord message delivery will retry')
        }
      })
    const endpoint = (path: string) => new URL(path, input.endpoint)
    const post = (path: string, payload: unknown, timeout: number) =>
      Effect.promise((signal) =>
        sendRelayJson({
          endpoint: endpoint(path),
          token: input.token,
          owner,
          payload,
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        }),
      )
    const heartbeat = (ready: boolean) =>
      post('/gateway/heartbeat', { ready, guildId: input.guildId, channels: [...input.channels] }, 5_000)
    if ((yield* heartbeat(false)) === false) {
      return yield* Effect.die(new Error('Worker has not admitted the Discord relay'))
    }
    const interactions = yield* Queue.dropping<{
      payload: Discord.GatewayInteractionCreateDispatchData
      receivedAt: number
    }>(32)
    const onInteraction = (payload: Discord.GatewayInteractionCreateDispatchData) =>
      payload.guild_id !== input.guildId
        ? Effect.void
        : Queue.offer(interactions, { payload, receivedAt: Date.now() }).pipe(
            Effect.flatMap((offered) =>
              offered === true ? Effect.void : Effect.logWarning('Discord relay interaction queue is full'),
            ),
          )
    const dispatch = Stream.fromQueue(interactions).pipe(
      Stream.mapEffect(
        ({ payload, receivedAt }) => {
          const age = Date.now() - receivedAt
          return age > 750
            ? Effect.logWarning('Discord relay interaction expired before forwarding')
            : post('/gateway/interactions', payload, 60_000).pipe(
                Effect.flatMap((sent) =>
                  sent === true ? Effect.void : Effect.logWarning('Discord relay interaction delivery failed'),
                ),
              )
        },
        { concurrency: 8 },
      ),
      Stream.runDrain,
    )
    // A full outbox may have stopped the previous Gateway reader. Make
    // capacity before reconnecting so replay cannot trap it in a restart loop.
    let isReady = () => false
    const run = Effect.gen(function* () {
      yield* drain(true)
      const gateway = yield* openRelayGateway({ ...input, onInteraction })
      let established = false
      const monitor = Stream.runForEach(gateway.lifecycle, (event) =>
        Effect.sync(() => {
          established = event._tag === 'Ready' || event._tag === 'Resumed'
        }),
      )
      isReady = () => established && gateway.heartbeatHealthy()
      return yield* Effect.raceFirst(
        gateway.failure,
        Effect.all([drain(false), dispatch, monitor], { concurrency: 'unbounded', discard: true }),
      )
    })
    const report = Effect.gen(function* () {
      const ready = isReady()
      if ((yield* heartbeat(ready)) === false) {
        return yield* Effect.die(new Error('Worker stopped admitting the Discord relay'))
      }
      yield* Effect.sleep('15 seconds')
    }).pipe(Effect.forever)
    return yield* Effect.raceFirst(run, report)
  }).pipe(Effect.scoped)
