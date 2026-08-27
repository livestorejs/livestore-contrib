import { it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

import { makeFakeDoStorage } from './fake-do-storage.ts'
import {
  gatewayTelemetryAggregateKey,
  makeDurableObjectGatewayTelemetrySink,
} from './gateway-telemetry-do.ts'

it.effect('persists one bounded aggregate across runtime recreation', () =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage()
    const firstRuntime = makeDurableObjectGatewayTelemetrySink(storage)

    yield* firstRuntime.append({ _tag: 'Activated', activationId: 'activation-a', at: 1_000 })
    yield* firstRuntime.append({
      _tag: 'AttemptStarted',
      activationId: 'activation-a',
      at: 1_010,
      attempt: 1,
      mode: 'identify',
    })
    yield* firstRuntime.append({
      _tag: 'Ready',
      activationId: 'activation-a',
      at: 1_020,
      attempt: 1,
    })

    const recreatedRuntime = makeDurableObjectGatewayTelemetrySink(storage)
    expect(yield* recreatedRuntime.aggregate).toMatchObject({
      lifetime: {
        attempts: 1,
        identifies: 1,
        lastReadyAt: 1_020,
      },
      current: {
        activationId: 'activation-a',
        attempt: 1,
        lastReadyAt: 1_020,
      },
    })
    expect([...((yield* Effect.promise(() => storage.list())).keys())]).toEqual([
      gatewayTelemetryAggregateKey,
    ])
  }))

it.effect('serializes concurrent updates without losing monotonic counters or timestamps', () =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage()
    const sink = makeDurableObjectGatewayTelemetrySink(storage)

    yield* sink.append({ _tag: 'Activated', activationId: 'activation-a', at: 1_000 })
    yield* Effect.all(
      Array.from({ length: 20 }, (_, index) =>
        sink.append({
          _tag: 'AttemptStarted' as const,
          activationId: 'activation-a',
          at: 1_010 + index,
          attempt: index + 1,
          mode: 'identify' as const,
        })),
      { concurrency: 'unbounded' },
    )
    yield* Effect.all(
      Array.from({ length: 19 }, (_, index) =>
        sink.append({
          _tag: 'Disconnected' as const,
          activationId: 'activation-a',
          at: 1_100 + index,
          attempt: index + 1,
        })),
      { concurrency: 'unbounded' },
    )
    yield* sink.append({ _tag: 'Ready', activationId: 'activation-a', at: 2_000, attempt: 20 })
    yield* sink.append({ _tag: 'Ready', activationId: 'activation-a', at: 1_500, attempt: 3 })

    expect(yield* sink.aggregate).toMatchObject({
      lifetime: {
        attempts: 20,
        identifies: 20,
        reconnects: 19,
        lastReadyAt: 2_000,
      },
      current: {
        attempt: 20,
        lastReadyAt: 2_000,
      },
    })
  }))


it.effect('rejects a late old-runtime write after a concurrent new activation claim', () =>
  Effect.gen(function* () {
    const sink = makeDurableObjectGatewayTelemetrySink(makeFakeDoStorage())
    yield* sink.append({ _tag: 'Activated', activationId: 'old-activation', at: 1_000 })
    yield* sink.append({
      _tag: 'AttemptStarted',
      activationId: 'old-activation',
      at: 1_010,
      attempt: 1,
      mode: 'identify',
    })

    const newActivationStored = yield* Deferred.make<void>()
    yield* Effect.all([
      Deferred.await(newActivationStored).pipe(
        Effect.andThen(sink.append({
          _tag: 'TerminalClose',
          activationId: 'old-activation',
          at: 1_100,
          attempt: 1,
          code: 4_014,
        })),
      ),
      sink.append({
        _tag: 'Activated',
        activationId: 'new-activation',
        at: 1_090,
      }).pipe(Effect.andThen(Deferred.succeed(newActivationStored, undefined))),
    ], { concurrency: 'unbounded' })

    expect(yield* sink.aggregate).toMatchObject({
      lifetime: {
        attempts: 1,
        identifies: 1,
        reconnects: 0,
        terminalCloses: 0,
      },
      current: {
        activationId: 'new-activation',
        state: 'activated',
        attempt: 0,
        terminalCloseCode: null,
        lastDisconnectedAt: null,
      },
    })
  }))