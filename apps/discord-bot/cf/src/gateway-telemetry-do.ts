import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'

import {
  reduceGatewayObservation,
  type GatewayObservation,
  type GatewayTelemetrySink,
  type GatewayTelemetrySnapshot,
} from './gateway-telemetry.ts'
import type { DurableStorage } from './storage.ts'

/** The one bounded, content-free gateway aggregate owned by the gateway DO. */
export const gatewayTelemetryAggregateKey = 'gateway-telemetry:aggregate:v1'

/**
 * Durable gateway telemetry over one KV value. The lock covers read/reduce/write
 * as one critical section so concurrent supervisor and alarm fibers cannot lose
 * counter increments. Durable Object input gates serialize separate executions;
 * this lock serializes fibers within the current execution.
 */
export const makeDurableObjectGatewayTelemetrySink = (
  storage: DurableStorage,
): GatewayTelemetrySink => {
  const lock = Effect.runSync(Semaphore.make(1))

  const readAggregate = Effect.map(
    Effect.promise(() => storage.get<GatewayTelemetrySnapshot>(gatewayTelemetryAggregateKey)),
    (snapshot) => snapshot ?? null,
  )

  const append = (observation: GatewayObservation): Effect.Effect<void> =>
    Semaphore.withPermits(lock, 1)(
      Effect.gen(function* () {
        const current = yield* readAggregate
        const next = reduceGatewayObservation(current, observation)
        yield* Effect.asVoid(
          Effect.promise(() => storage.put(gatewayTelemetryAggregateKey, next)),
        )
      }),
    )

  return {
    append,
    aggregate: Semaphore.withPermits(lock, 1)(readAggregate),
  }
}
