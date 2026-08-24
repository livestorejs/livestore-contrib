import { Effect, Option, PubSub, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

describe('DFX lifecycle replay admission', () => {
  it('delivers READY to a subscriber created after the event', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* PubSub.bounded({ capacity: 1024, replay: 1024 })
        yield* PubSub.publish(hub, { _tag: 'Ready' as const, shardId: 0 })
        const received = yield* Stream.runHead(Stream.fromPubSub(hub))
        yield* PubSub.shutdown(hub)
        return received
      }),
    )

    expect(Option.getOrThrow(result)).toEqual({ _tag: 'Ready', shardId: 0 })
  })
})
