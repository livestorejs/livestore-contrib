import { Effect } from 'effect'

import { forwardRelayMessage } from './forward.ts'
import { openRelayGateway } from './gateway.ts'
import type { RelayOutbox } from './outbox.ts'

/** Run the relay only after the caller has acquired the stage's Gateway authority. */
export const runMessageRelay = (input: {
  readonly botToken: string
  readonly guildId: string
  readonly channels: ReadonlySet<string>
  readonly endpoint: URL
  readonly token: string
  readonly outbox: RelayOutbox
}) =>
  Effect.gen(function* () {
    const drain = (untilEmpty: boolean) =>
      Effect.gen(function* () {
        let retryDelayMs = 1_000
        for (;;) {
          const outcome = yield* Effect.promise((signal) =>
            forwardRelayMessage({
              endpoint: input.endpoint,
              token: input.token,
              outbox: input.outbox,
              signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            }),
          )
          if (outcome === 'retry') {
            yield* Effect.sleep(retryDelayMs)
            retryDelayMs = Math.min(retryDelayMs * 2, 30_000)
          } else {
            retryDelayMs = 1_000
            if (outcome === 'empty') {
              if (untilEmpty === true) return
              yield* Effect.sleep(250)
            }
          }
        }
      })
    // A full outbox may have stopped the previous Gateway reader. Make
    // capacity before reconnecting so replay cannot trap it in a restart loop.
    yield* drain(true)
    const gateway = yield* openRelayGateway(input)
    return yield* Effect.raceFirst(gateway.failure, drain(false))
  }).pipe(Effect.scoped)
