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

export const makeSupervisorGate: Effect.Effect<SupervisorGate> = Effect.map(Ref.make(false), (ref) => ({
  tryBegin: Ref.modify(ref, (running) => (running === false ? [true, true] : [false, running])),
  end: Ref.set(ref, false),
}))

/**
 * Bound the lifetime of a claimed owner even if it stalls before its first
 * supervisor attempt (where an attempt-local timeout cannot observe it).
 */
export const makeGatewayOwnerDeadline = (windowMillis: number) => {
  let claimedAt: number | undefined
  return {
    observe: (now: number, claimed: boolean, readyOrStopped: boolean) => {
      if (claimed === true) claimedAt = now
      else if (readyOrStopped === true) claimedAt = undefined
      else claimedAt ??= now
      return {
        claimedAt,
        overdue: claimed === false && claimedAt !== undefined && now - claimedAt >= windowMillis,
      }
    },
    reset: () => {
      claimedAt = undefined
    },
  }
}

/**
 * An alarm deadline this far in the past is no longer pending delivery: Cloudflare
 * stops retrying an alarm whose handler kept failing, yet `getAlarm()` still returns
 * the old deadline, so the chain is dead even though an alarm appears to exist.
 */
const staleAlarmMillis = 120_000

/** Cron and pending admin handlers may wake the alarm, never the owner. */
export const scheduleGatewayAlarmIfMissing = (
  storage: {
    readonly getAlarm: () => Promise<number | null | undefined>
    readonly setAlarm: (when: number) => Promise<void>
  },
  now: () => number = Date.now,
): Effect.Effect<{ readonly repaired: boolean; readonly scheduledAt: number }> =>
  Effect.promise(async () => {
    const scheduled = await storage.getAlarm()
    const current = now()
    if (scheduled !== null && scheduled !== undefined && current - scheduled < staleAlarmMillis) {
      return { repaired: false, scheduledAt: scheduled }
    }
    await storage.setAlarm(current)
    return { repaired: true, scheduledAt: current }
  })

/** Failed alarm invocations retry without turning persistent build errors into a hot loop. */
export const makeGatewayAlarmRetry = (
  storage: { readonly setAlarm: (when: number) => Promise<void> },
  now: () => number = Date.now,
) => {
  let failures = 0
  return <A, E, R>(alarm: Effect.Effect<A, E, R>, expiresAt = Infinity): Effect.Effect<A, E, R> =>
    alarm.pipe(
      Effect.onExit((exit) => {
        if (exit._tag === 'Success') {
          failures = 0
          return Effect.void
        }
        const delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures++, 4))
        return Effect.promise(() => storage.setAlarm(Math.min(now() + delay, expiresAt))).pipe(
          Effect.tap(() => Effect.sync(() => console.warn(`[bot-state] alarm failed; retryScheduledInMs=${delay}`))),
        )
      }),
    )
}
