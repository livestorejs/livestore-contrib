import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import type { AdminOperationOutcome } from './admin-ops.ts'
import type { DurableStorage } from './storage.ts'

const owner = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._:-]{1,128}$/))
const activatePayload = Schema.Struct({
  owner,
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_800 })),
})
const parkPayload = Schema.Struct({ owner })
const leaseSchema = Schema.Struct({ owner, expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
type GatewayLease = typeof leaseSchema.Type

const leaseKey = 'livestore-discord/staging-gateway-lease'
const outcome = (status: number, body: AdminOperationOutcome['body']): AdminOperationOutcome => ({
  ok: status === 200,
  status,
  body,
})
const stagingOnly = outcome(403, { error: 'Gateway lease operations are available in staging only' })
const conflictingOwner = outcome(409, { error: 'The staging gateway is leased by a different owner' })
const parked = outcome(200, { state: 'parked' })
const active = (lease: GatewayLease) => outcome(200, { state: 'active', ...lease })

type LeaseStorage = Pick<DurableStorage, 'get' | 'put' | 'delete'> & {
  readonly setAlarm: (when: number) => Promise<void>
  readonly getAlarm: () => Promise<number | null>
  readonly deleteAlarm: () => Promise<void>
}

export const makeGatewayLease = (
  stage: 'staging' | 'production',
  storage: LeaseStorage,
  stopGateway: Effect.Effect<void>,
  now = Date.now,
) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    const serialized = Semaphore.withPermits(lock, 1)
    const operations = new Set<Effect.Effect<void>>()
    const read = Effect.promise(() => storage.get<unknown>(leaseKey)).pipe(
      Effect.map(Schema.decodeUnknownOption(leaseSchema)),
    )
    const park = Effect.gen(function* () {
      // Operations never hold the lease or runtime lifecycle mutex during I/O.
      // Cancel them before reset so upstream retries cannot delay shutdown.
      for (const interrupt of operations) yield* interrupt
      yield* stopGateway
      yield* Effect.promise(() => storage.delete(leaseKey))
      yield* Effect.promise(() => storage.deleteAlarm())
    })
    const current = Effect.gen(function* () {
      const lease = yield* read
      if (Option.isSome(lease) === true && lease.value.expiresAt > now()) return lease.value
      // This also clears an inherited alarm when the first lease-aware release
      // replaces a staging deployment that used to keep itself running.
      if (Option.isSome(lease) === true || (yield* Effect.promise(() => storage.getAlarm())) !== null) yield* park
      return undefined
    })

    return {
      whileActive: <A, B, E, R>(
        onActive: (expiresAt: number | undefined) => Effect.Effect<A, E, R>,
        onParked: Effect.Effect<B>,
      ): Effect.Effect<A | B, E, R> =>
        stage === 'production'
          ? Effect.suspend(() => onActive(undefined))
          : serialized(
              Effect.gen(function* () {
                const lease = yield* current
                if (lease === undefined) return yield* onParked
                // Maintenance may await external services while holding this
                // lock. Cancel it at expiry so it cannot prevent gateway stop.
                const result = yield* onActive(lease.expiresAt).pipe(
                  Effect.timeoutOption(Math.max(0, lease.expiresAt - now())),
                )
                if (Option.isSome(result) === true) return result.value
                yield* park
                return yield* onParked
              }),
            ),

      withActiveOperation: <A, B, E, R>(
        onActive: Effect.Effect<A, E, R>,
        onParked: Effect.Effect<B>,
      ): Effect.Effect<A | B, E, R> =>
        stage === 'production'
          ? onActive
          : Effect.gen(function* () {
              const result = yield* Effect.acquireUseRelease(
                serialized(
                  Effect.gen(function* () {
                    const lease = yield* current
                    if (lease === undefined) return undefined
                    const fiber = yield* Effect.forkChild(
                      onActive.pipe(Effect.timeoutOption(Math.max(0, lease.expiresAt - now())), Effect.interruptible),
                    )
                    const interrupt = Fiber.interrupt(fiber).pipe(Effect.asVoid)
                    operations.add(interrupt)
                    return { fiber, interrupt }
                  }),
                ),
                (running) => (running === undefined ? Effect.succeed(Option.none<A>()) : Fiber.join(running.fiber)),
                (running) =>
                  running === undefined
                    ? Effect.void
                    : running.interrupt.pipe(Effect.ensuring(Effect.sync(() => operations.delete(running.interrupt)))),
              )
              if (Option.isSome(result) === true) return result.value
              // Re-read under the lock: a newer owner may already have replaced
              // the expired lease while this operation was being cancelled.
              yield* serialized(current)
              return yield* onParked
            }),

      activate: (payload: unknown): Effect.Effect<AdminOperationOutcome> =>
        stage === 'production'
          ? Effect.succeed(stagingOnly)
          : serialized(
              Effect.gen(function* () {
                const input = Schema.decodeUnknownOption(activatePayload)(payload)
                if (Option.isNone(input) === true)
                  return outcome(422, { error: 'Expected a valid owner and ttlSeconds (1–10800)' })
                const existing = yield* current
                if (existing !== undefined) {
                  if (existing.owner !== input.value.owner) return conflictingOwner
                  // A retried activation repairs a missing alarm without extending the lease.
                  if ((yield* Effect.promise(() => storage.getAlarm())) === null) {
                    yield* Effect.promise(() => storage.setAlarm(now()))
                  }
                  return active(existing)
                }
                const lease = { owner: input.value.owner, expiresAt: now() + input.value.ttlSeconds * 1_000 }
                // An alarm is harmless without the lease. Persist it first so an
                // interrupted write cannot leave a committed lease with no wakeup.
                yield* Effect.promise(() => storage.setAlarm(now()))
                yield* Effect.promise(() => storage.put(leaseKey, lease))
                return active(lease)
              }),
            ),

      park: (payload: unknown): Effect.Effect<AdminOperationOutcome> =>
        stage === 'production'
          ? Effect.succeed(stagingOnly)
          : serialized(
              Effect.gen(function* () {
                const input = Schema.decodeUnknownOption(parkPayload)(payload)
                if (Option.isNone(input) === true) return outcome(422, { error: 'Expected a valid owner' })
                const existing = yield* current
                if (existing === undefined) return parked
                if (existing.owner !== input.value.owner) return conflictingOwner
                yield* park
                return parked
              }),
            ),
    }
  })
