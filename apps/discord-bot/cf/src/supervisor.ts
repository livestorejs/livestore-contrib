/**
 * Gateway reconnect supervisor — outer supervision over dfx's Shard reconnect.
 *
 * Pure Effect module: all side effects (websocket acquisition, persistence,
 * time, jitter) are injected, so the full state machine is unit-testable
 * against `effect/testing/TestClock` without a worker or network.
 *
 * States: disconnected → connecting | resuming → ready → (disconnected | stopped)
 *
 * Responsibilities (deliberately narrow):
 * - decide IDENTIFY vs RESUME per attempt from persisted session state
 * - persist session_id + sequence via the injected store (DO in production)
 * - exponential backoff with cap and full jitter between attempts
 * - classify close codes: dfx terminal codes halt supervision entirely;
 *   everything else retries (every close is an error per effect/unstable/socket)
 * - survive isolate crashes/deploys: durable state lives in the store, not the process
 */
import * as Cause from 'effect/Cause'
import { defaultCloseCodeIsError } from 'effect/unstable/socket/Socket'
import * as Clock from 'effect/Clock'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { isTerminalGatewayCloseCode } from 'dfx/DiscordGateway/DiscordWS'

import type { Scope } from 'effect/Scope'

// ---------------------------------------------------------------------------
// Errors & data
// ---------------------------------------------------------------------------

/** Session ended with a close code dfx classifies as terminal (4004, 4010–4014). */
export class TerminalCloseError extends Data.TaggedError('TerminalCloseError')<{
  readonly code: number
  readonly reason?: string
}> {}

/** Session ended retryably (network blip, deploy, gateway reconnect…). */
export class DisconnectedError extends Data.TaggedError('DisconnectedError')<{
  readonly code?: number
  readonly reason?: string
}> {}

export type SessionFailure = TerminalCloseError | DisconnectedError

export interface GatewaySession {
  readonly sessionId: string
  readonly sequence: number
  readonly resumeUrl?: string | undefined
}

export type ConnectMode =
  | { readonly _tag: 'Identify' }
  | { readonly _tag: 'Resume'; readonly session: GatewaySession }

export type SupervisorState =
  | 'disconnected'
  | 'connecting'
  | 'resuming'
  | 'ready'
  | 'stopped'

/** Events the live gateway session reports back to the supervisor. */
export type SessionEvent =
  | { readonly _tag: 'Ready'; readonly session: GatewaySession }
  | { readonly _tag: 'Resumed'; readonly session: GatewaySession }

// Persistence ownership is SINGLE: the supervisor persists session_id +
// sequence at READY/RESUMED checkpoints; intra-session replay-sequence
// advancement is persisted by dfx's own ShardStateStore (which writes BEFORE
// publishing dispatches — the correct crash ordering). Wire both to the same
// durable store. Downstream event delivery is therefore at-least-once:
// domain handlers must be idempotent per gateway event.

/** Observable transitions emitted by the supervisor itself. */
export type Transition =
  | { readonly _tag: 'StateChanged'; readonly state: SupervisorState }
  | {
      readonly _tag: 'RetryScheduled'
      readonly attempt: number
      readonly delayMillis: number
    }
  | {
      readonly _tag: 'Stopped'
      readonly code?: number
      readonly reason?: string
    }

// ---------------------------------------------------------------------------
// Close-code classification
// ---------------------------------------------------------------------------

/**
 * Re-exported dfx classifier (`isTerminalGatewayCloseCode`, patched export):
 * Discord requires configuration/credential changes before these codes can
 * succeed, so reconnecting only consumes identify capacity.
 */
export const isTerminalClose = isTerminalGatewayCloseCode

/**
 * Map a raw websocket close to a classified session failure. Every close is an
 * error by default (`defaultCloseCodeIsError`, effect/unstable/socket); only
 * dfx's terminal set escalates beyond retry.
 */
export const sessionEndFromClose = (
  code: number | undefined,
  reason: string | undefined,
  /**
   * Effect's socket error predicate (`closeCodeIsError` socket option).
   * Defaults to `defaultCloseCodeIsError`, which treats every websocket close
   * as an error — so all closes reach this classifier unless the wiring opts
   * specific codes out.
   */
  closeCodeIsError: (code: number) => boolean = defaultCloseCodeIsError,
): SessionFailure =>
  code !== undefined && closeCodeIsError(code) && isTerminalGatewayCloseCode(code)
    ? new TerminalCloseError({
        code,
        ...(reason === undefined ? {} : { reason }),
      })
    : new DisconnectedError({
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      })

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SessionHandle {
  /**
   * Completes when this gateway session ends: succeeds on a clean end, fails
   * with the classified SessionFailure, or dies if the underlying fiber
   * crashed (the supervisor treats any death as retryable).
   */
  readonly join: Effect.Effect<void, SessionFailure>
}

/**
 * Starts one gateway session (dfx Shard connect under outer supervision).
 * Must not fail: a startup crash is reported by dying/failing `handle.join`.
 * The supervisor runs `acquire` inside a PER-ATTEMPT scope: fork the shard
 * connect with `forkScoped` there so it finalizes the moment the attempt ends,
 * not when the whole run-loop scope closes (zombie sockets would otherwise
 * persist through backoff windows and open duplicate connections).
 *
 * `emit` forwards READY / RESUMED / sequence progress to the supervisor, which
 * owns ALL persistence — the inner layer never touches the store directly.
 */
export type Acquire = (
  mode: ConnectMode,
  emit: (event: SessionEvent) => Effect.Effect<void>,
) => Effect.Effect<SessionHandle, never, Scope>

export interface SupervisorDeps {
  readonly acquire: Acquire
  readonly loadSession: Effect.Effect<GatewaySession | null>
  readonly saveSession: (session: GatewaySession) => Effect.Effect<void>
  readonly clearSession: Effect.Effect<void>
}

export interface SupervisorOptions {
  readonly initialBackoff: Duration.Input
  readonly maxBackoff: Duration.Input
  /**
   * Disconnects within this window of a fresh READY/RESUMED count as deploy
   * churn (deploys kill the socket): the escalation counter resets so routine
   * restarts neither back off harder nor waste time. Default: 30 seconds.
   */
  readonly gracePeriod?: Duration.Input | undefined
  /** Jitter source in [0, 1). Defaults to Math.random; inject for tests. */
  readonly random?: Effect.Effect<number> | undefined
}

export const defaultGracePeriod = Duration.seconds(30)

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/** Exponential backoff capped at `maxBackoff`: min(cap, base · 2^attempt). */
export const uncappedBackoffMillis = (
  attempt: number,
  initialBackoff: Duration.Input,
  maxBackoff: Duration.Input,
): number =>
  Math.min(
    Duration.toMillis(maxBackoff),
    Duration.toMillis(initialBackoff) * 2 ** attempt,
  )

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface Supervisor {
  readonly state: Effect.Effect<SupervisorState>
  readonly transitions: Queue.Queue<Transition>
  /**
   * The supervision loop: fork it (`start`, or your own `forkScoped`) — it
   * runs until the session hits a terminal close (state → "stopped", loop
   * exits) or is interrupted. Each attempt runs in its OWN scope, so inner
   * session resources (websocket, shard fiber) finalize when that attempt
   * ends — nothing leaks through backoff windows.
   */
  readonly run: Effect.Effect<void>
  /**
   * Forks `run` in the CALLER's scope; idempotent while a loop is already
   * running. Interrupting that scope (or `stop`) tears the loop down.
   */
  readonly start: Effect.Effect<void, never, Scope>
  /**
   * Graceful shutdown: interrupts the loop and its inner session, leaving the
   * persisted session intact (a later boot can resume).
   */
  readonly stop: Effect.Effect<void>
}

/** Outcome of one connect attempt, classified for the supervision loop. */
interface AttemptOutcome {
  readonly failure: SessionFailure
  /** Clock millis at which the session became ready/resumed, if it did. */
  readonly establishedAt: number | undefined
}

export const make = Effect.fnUntraced(function* (
  deps: SupervisorDeps,
  options: SupervisorOptions,
) {
  const capMillis = Duration.toMillis(options.maxBackoff)
  const graceMillis = options.gracePeriod
    ? Duration.toMillis(options.gracePeriod)
    : Duration.toMillis(defaultGracePeriod)
  const random = options.random ?? Effect.sync(() => Math.random())
  const stateRef = yield* Ref.make<SupervisorState>('disconnected')
  const transitions = yield* Queue.unbounded<Transition>()
  const running = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null)

  // Offers are shutdown-safe (they resolve to `false` once the queue is done,
  // e.g. when `stop()` is called after a terminal halt).
  const publish = (transition: Transition) => Effect.asVoid(Queue.offer(transitions, transition))

  const setState = (state: SupervisorState) =>
    Ref.set(stateRef, state).pipe(Effect.andThen(publish({ _tag: 'StateChanged', state })))

  /**
   * Record a READY/RESUMED checkpoint: persist the session (single
   * persistence owner — the supervisor), stamp establishment time for the
   * deploy-churn grace, and flip to ready. Monotonic guard: a stale event
   * carrying an older replay sequence must never regress the store.
   */
  const recordEstablished = (
    latest: Ref.Ref<GatewaySession | null>,
    setEstablishedAt: (millis: number) => void,
    event: Extract<SessionEvent, { _tag: 'Ready' | 'Resumed' }>,
  ) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(latest)
      if (previous !== null && event.session.sequence < previous.sequence) {
        return
      }
      yield* Ref.set(latest, event.session)
      setEstablishedAt(yield* Clock.currentTimeMillis)
      yield* setState('ready')
      yield* deps.saveSession(event.session)
    }).pipe(Effect.uninterruptible)

  // One connect attempt: load session → acquire → pump events until the
  // session ends. Never fails or dies; every ending becomes a classified
  // AttemptOutcome (crashes included, as retryable disconnects).
  const attemptOnce = Effect.gen(function* () {
    const session = yield* deps.loadSession
    const mode: ConnectMode = session ? { _tag: 'Resume', session } : { _tag: 'Identify' }
    yield* setState(session ? 'resuming' : 'connecting')

    const latest = yield* Ref.make<GatewaySession | null>(session)
    let establishedAt: number | undefined

    const inbox = yield* Queue.unbounded<SessionEvent>()
    const emit = (event: SessionEvent) => Queue.offer(inbox, event).pipe(Effect.asVoid)

    const onEvent = (event: SessionEvent) =>
      event._tag === 'Ready' || event._tag === 'Resumed'
        ? recordEstablished(
          latest,
          (millis) => {
            establishedAt = millis
          },
          event,
        )
        : Effect.void

    const pump = yield* Effect.forkScoped(
      Effect.whileLoop({
        while: () => true,
        body: () => Effect.flatMap(Queue.take(inbox), onEvent),
        step: () => undefined,
      }),
    )

    const end = yield* Effect.exit(
      deps.acquire(mode, emit).pipe(Effect.flatMap((handle) => handle.join)),
    )

    yield* Fiber.interrupt(pump)
    // A session may emit READY/RESUMED right before it ends; process anything
    // still buffered so persistence and `establishedAt` cannot lose the race.
    // Uninterruptible: a half-applied checkpoint is worse than a late one.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const pending = yield* Queue.size(inbox)
        for (let n = 0; n < pending; n++) {
          yield* onEvent(yield* Queue.take(inbox))
        }
      }),
    )
    yield* Queue.shutdown(inbox)

    // Classify the ending: clean success → retryable; failed cause → its
    // error; died cause (crash-in-connecting) → retryable disconnect.
    // `establishedAt` flows through EVERY branch: the deploy-churn grace in
    // the run loop depends on knowing when this attempt got established.
    let outcome: AttemptOutcome
    if (end._tag === 'Success') {
      outcome = { failure: new DisconnectedError({}), establishedAt }
    } else {
      const foundFail = Cause.findFail(end.cause)
      outcome = Result.isSuccess(foundFail)
        ? { failure: foundFail.success.error, establishedAt }
        : { failure: new DisconnectedError({ reason: 'crash' }), establishedAt }
    }
    return outcome
  })

  const run: Effect.Effect<void> = Effect.gen(function* () {
    yield* setState('disconnected')
    let attempt = 0

    while (true) {
      // Own scope per attempt: acquire-side `forkScoped` resources finalize
      // the moment the session ends instead of leaking through backoff waits.
      const { establishedAt, failure } = yield* Effect.scoped(attemptOnce)

      if (failure._tag === 'TerminalCloseError') {
        // Retry policy: halt permanently — reconnecting only consumes identify
        // capacity. Drop the dead session so the next boot (after the operator
        // fixes config/token/shard layout) identifies freshly.
        yield* deps.clearSession
        yield* setState('stopped')
        yield* publish({
          _tag: 'Stopped',
          ...(failure.code === undefined ? {} : { code: failure.code }),
          ...(failure.reason === undefined ? {} : { reason: failure.reason }),
        })
        return
      }

      // Deploy-churn grace: a disconnect right after establishment is a
      // restart, not a degradation — reset the escalation counter.
      const now = yield* Clock.currentTimeMillis
      if (establishedAt !== undefined && now - establishedAt < graceMillis) {
        attempt = 0
      }

      const capped = uncappedBackoffMillis(attempt, options.initialBackoff, options.maxBackoff)
      const jitter = yield* random
      const delayMillis = Math.min(capMillis, Math.floor(jitter * capped))
      attempt++
      yield* publish({
        _tag: 'RetryScheduled',
        attempt,
        delayMillis,
      })
      yield* setState('disconnected')
      yield* Effect.sleep(Duration.millis(delayMillis))
    }
  }).pipe(Effect.ensuring(Queue.shutdown(transitions)))

  // Serializes start attempts so two concurrent callers cannot both observe
  // an empty slot and fork duplicate supervision loops.
  const startLock = yield* Semaphore.make(1)

  const start = Semaphore.withPermits(startLock, 1)(
    Effect.gen(function* () {
      if ((yield* Ref.get(running)) === null) {
        yield* Ref.set(running, yield* Effect.forkScoped(run))
      }
    }),
  )

  const stop = Ref.get(running).pipe(
    Effect.flatMap((fiber) =>
      fiber === null ? Effect.void : Effect.asVoid(Fiber.interrupt(fiber)),
    ),
    Effect.andThen(Ref.set(running, null)),
    Effect.andThen(setState('stopped')),
  )

  return {
    state: Ref.get(stateRef),
    transitions,
    run,
    start,
    stop,
  } satisfies Supervisor
})

// ---------------------------------------------------------------------------
// dfx Shard acquire seam
// ---------------------------------------------------------------------------

/** Structural slice of dfx's RunningShard consumed by the acquire seam. */
export interface RunningShardLike {
  /** Ends when the session terminates; elements carry close classification inputs. */
  readonly lifecycle: Stream.Stream<LifecycleEventLike>
}

export interface LifecycleEventLike {
  readonly _tag: 'Connecting' | 'Ready' | 'Resumed' | 'Disconnected'
  readonly shardId: number
  readonly code?: number
  readonly retryable?: boolean
}

export interface MakeShardAcquireOptions {
  /** Single-shard layout: the bot runs one gateway connection per DO. */
  readonly shard: readonly [id: number, count: number]
  /** Pre-bound `Shard.connect([id, count])` from the assembled dfx layer graph. */
  readonly connect: () => Effect.Effect<RunningShardLike, unknown, Scope>
  /**
   * The SAME durable home the supervisor persists checkpoints to (DO storage):
   * syncing it before each attempt is what makes dfx itself IDENTIFY or RESUME
   * in agreement with the supervisor's decision.
   */
  readonly loadShardState: Effect.Effect<
    { readonly resumeUrl: string; readonly sequence: number | null; readonly sessionId: string } | undefined
  >
  readonly saveShardState: (
    state: { readonly resumeUrl: string; readonly sequence: number | null; readonly sessionId: string },
  ) => Effect.Effect<void>
  readonly clearShardState: Effect.Effect<void>
}

/**
 * Builds the production `Acquire` over a dfx Shard: syncs the shared shard
 * state with the supervisor's decision, forks ONE `connect` under the caller's
 * (per-attempt) scope, translates dfx lifecycle events into SessionEvents, and
 * classifies every session end through `sessionEndFromClose` — patched dfx
 * treats every close as a socket error, so all of them arrive here.
 */
export const makeShardAcquire = (options: MakeShardAcquireOptions): Acquire =>
  (mode, emit) =>
    Effect.gen(function* () {
      if (mode._tag === 'Identify') {
        yield* options.clearShardState
      } else {
        yield* options.saveShardState({
          resumeUrl: mode.session.resumeUrl ?? '',
          sessionId: mode.session.sessionId,
          sequence: mode.session.sequence,
        })
      }

      const fiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          // A connect failure (layer build, socket setup) is reported through
          // the same join channel as any other session end: retryable.
          const running = yield* Effect.mapError(
            options.connect(),
            () => new DisconnectedError({ reason: 'connect-failed' }),
          )
          let end: SessionFailure | undefined
          yield* Stream.runForEach(running.lifecycle, (event) => {
            if (event._tag === 'Ready' || event._tag === 'Resumed') {
              return Effect.flatMap(options.loadShardState, (state) => {
                const session: GatewaySession = {
                  sessionId: state?.sessionId ?? '',
                  sequence: state?.sequence ?? 0,
                  ...(state?.resumeUrl ? { resumeUrl: state.resumeUrl } : {}),
                }
                return emit(event._tag === 'Ready' ? { _tag: 'Ready', session } : { _tag: 'Resumed', session })
              })
            }
            if (event._tag === 'Disconnected') {
              end = sessionEndFromClose(event.code, undefined)
            }
            return Effect.void
          })
          return yield* Effect.fail(end ?? new DisconnectedError({}))
        }),
      )
      return { join: Fiber.join(fiber) } satisfies SessionHandle
    })
