import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'

export interface SupervisorGate {
  /**
   * Atomically claims the supervision slot: exactly one caller in a field of
   * concurrent ticks observes `true`. The check-and-set happens inside a
   * single `Ref.modify` with NO intervening yield, so two overlapping alarm
   * or cron ticks can never both fork `supervisor.run` (duplicate gateway
   * sessions racing the shared shard-state keys).
   */
  readonly tryBegin: Effect.Effect<boolean>
  /** Releases the slot; called from the loop's `ensuring` finalizer. */
  readonly end: Effect.Effect<void>
}

export const makeSupervisorGate: Effect.Effect<SupervisorGate> =
  Effect.map(Ref.make(false), (ref) => ({
    tryBegin: Ref.modify(ref, (running) => (running === false ? [true, true] : [false, running])),
    end: Ref.set(ref, false),
  }))
