import { expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import {
  DisconnectedError,
  make,
  makeShardAcquire,
  sessionEndFromClose,
  uncappedBackoffMillis,
  type ConnectMode,
  type GatewaySession,
  type LifecycleEventLike,
  type SessionEvent,
  type SessionHandle,
  type SessionFailure,
  type Supervisor,
  type Transition,
} from "./supervisor.ts"

// ---------------------------------------------------------------------------
// Deterministic fake gateway + in-memory session store
// ---------------------------------------------------------------------------

interface ControlledSession {
  readonly mode: ConnectMode
  readonly emit: (event: SessionEvent) => Effect.Effect<void>
  readonly done: Deferred.Deferred<void, SessionFailure>
}

interface SessionStoreInspect {
  readonly session: GatewaySession | null
  readonly saves: Array<GatewaySession>
  readonly clears: number
}

interface SessionStore {
  readonly load: Effect.Effect<GatewaySession | null>
  readonly save: (session: GatewaySession) => Effect.Effect<void>
  readonly clear: Effect.Effect<void>
  readonly inspect: Effect.Effect<SessionStoreInspect>
}

interface FakeGateway {
  readonly acquire: (
    mode: ConnectMode,
    emit: (event: SessionEvent) => Effect.Effect<void>,
  ) => Effect.Effect<SessionHandle>
  readonly count: Effect.Effect<number>
  readonly lastMode: Effect.Effect<ConnectMode | undefined>
  readonly emitOn: (n: number, event: SessionEvent) => Effect.Effect<void>
  /** Ends session #n with a classified failure, or cleanly when omitted. */
  readonly endWith: (
    n: number,
    failure?: SessionFailure,
  ) => Effect.Effect<boolean>
  /** Crashes session #n's underlying fiber (defect surfaces through `join`). */
  readonly crash: (n: number) => Effect.Effect<boolean>
}

const makeStore = Effect.gen(function* () {
  const ref = yield* Ref.make<SessionStoreInspect>({
    session: null,
    saves: [],
    clears: 0,
  })
  return {
    load: Effect.map(Ref.get(ref), (s) => s.session),
    save: (session: GatewaySession) =>
      Ref.update(ref, (s) => ({
        ...s,
        session,
        saves: [...s.saves, session],
      })),
    clear: Ref.update(
      ref,
      (s) => ({ ...s, session: null, clears: s.clears + 1 }),
    ),
    inspect: Ref.get(ref),
  }
})

const makeGateway = Effect.sync((): FakeGateway => {
  const modes: Array<ConnectMode> = []
  const sessions: Array<ControlledSession> = []

  const acquire = (
    mode: ConnectMode,
    emit: (event: SessionEvent) => Effect.Effect<void>,
  ): Effect.Effect<SessionHandle> =>
    Effect.gen(function* () {
      modes.push(mode)
      const done = yield* Deferred.make<void, SessionFailure>()
      sessions.push({ mode, emit, done })
      return { join: Deferred.await(done) }
    })

  return {
    acquire,
    count: Effect.sync(() => modes.length),
    lastMode: Effect.sync(() => modes[modes.length - 1]),
    emitOn: (n, event) => Effect.suspend(() => sessions[n]!.emit(event)),
    endWith: (n, failure) =>
      Effect.suspend(() =>
        failure === undefined
          ? Deferred.succeed(sessions[n]!.done, void 0)
          : Deferred.fail(sessions[n]!.done, failure),
      ),
    crash: (n) =>
      Effect.suspend(() =>
        Deferred.die(sessions[n]!.done, new Error("boom")),
      ),
  }
})
const makeSupervisor = (gateway: FakeGateway, store: SessionStore) =>
  make(
    {
      acquire: gateway.acquire,
      loadSession: store.load,
      saveSession: store.save,
      clearSession: store.clear,
    },
    {
      initialBackoff: Duration.seconds(1),
      maxBackoff: Duration.seconds(8),
      random: Effect.succeed(1),
    },
  )

// ---------------------------------------------------------------------------
// Polling helpers (cooperative scheduling only — no wall-clock waits)
// ---------------------------------------------------------------------------

const waitFor = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (;;) {
      if (yield* check) break
      yield* Effect.yieldNow
    }
  })

const waitForSessions = (gateway: FakeGateway, n: number) =>
  waitFor(Effect.map(gateway.count, (c) => c >= n))

/** Takes transitions until the next RetryScheduled (skipping state echoes). */
const nextRetryDelay = (supervisor: Supervisor) =>
  Effect.gen(function* () {
    for (;;) {
      const transition = yield* Queue.take(supervisor.transitions)
      if (transition._tag === "RetryScheduled") return transition.delayMillis
      expect(transition._tag).toBe("StateChanged")
    }
  })

const fork = (supervisor: Supervisor) => Effect.forkScoped(supervisor.run)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.effect(
    "cold boot identifies freshly; graceful shutdown keeps the session for a later resume",
    () =>
      Effect.gen(function* () {
        const gateway = yield* makeGateway
        const store = yield* makeStore

        const supervisor = yield* makeSupervisor(gateway, store)
        const runner = yield* fork(supervisor)

        // First attempt with no persisted session: fresh IDENTIFY.
        yield* waitForSessions(gateway, 1)
        expect(yield* gateway.lastMode).toEqual({ _tag: "Identify" })

        // READY arrives → supervisor flips ready and persists the session.
        yield* gateway.emitOn(0, {
          _tag: "Ready",
          session: { sessionId: "s1", sequence: 7 },
        })
        yield* waitFor(supervisor.state.pipe(Effect.map((s) => s === "ready")))
        expect(yield* supervisor.state).toBe("ready")
        expect((yield* store.inspect).session).toEqual({
          sessionId: "s1",
          sequence: 7,
        })

        // Graceful shutdown: loop halts without marking "stopped"…
        yield* Fiber.interrupt(runner)
        expect(yield* supervisor.state).not.toBe("stopped")

        // …and a later boot over the same durable store RESUMES.
        const gateway2 = yield* makeGateway
        const supervisor2 = yield* makeSupervisor(gateway2, store)
        yield* fork(supervisor2)
        yield* waitForSessions(gateway2, 1)
        expect(yield* gateway2.lastMode).toEqual({
          _tag: "Resume",
          session: { sessionId: "s1", sequence: 7 },
        })
      }),
  )

it.effect(
    "resumes from persisted session and persists sequence advances",
    () =>
      Effect.gen(function* () {
        const gateway = yield* makeGateway
        const store = yield* makeStore
        yield* store.save({ sessionId: "s9", sequence: 42 })

        const supervisor = yield* makeSupervisor(gateway, store)
        yield* fork(supervisor)

        yield* waitForSessions(gateway, 1)
        expect(yield* gateway.lastMode).toEqual({
          _tag: "Resume",
          session: { sessionId: "s9", sequence: 42 },
        })
        // While resuming (pre-RESUMED) the observable state is "resuming".
        expect(yield* supervisor.state).toBe("resuming")

        yield* gateway.emitOn(0, {
          _tag: "Resumed",
          session: { sessionId: "s9", sequence: 43 },
        })
        yield* waitFor(supervisor.state.pipe(Effect.map((s) => s === "ready")))

        // Supervisor persists the RESUMED checkpoint only — intra-session
        // replay-sequence advancement is dfx's ShardStateStore's job.
        expect((yield* store.inspect).saves.slice(-1)).toEqual([
          { sessionId: "s9", sequence: 43 },
        ])

        // Monotonic guard: a stale checkpoint must not regress the store.
        yield* gateway.emitOn(0, {
          _tag: "Resumed",
          session: { sessionId: "s9", sequence: 42 },
        })
        yield* Effect.yieldNow
        expect((yield* store.inspect).session?.sequence).toBe(43)
      }),
  )

it.effect(
    "terminal close stops supervision permanently and clears the session",
    () =>
      Effect.gen(function* () {
        const gateway = yield* makeGateway
        const store = yield* makeStore
        yield* store.save({ sessionId: "sX", sequence: 1 })

        const supervisor = yield* makeSupervisor(gateway, store)
        yield* fork(supervisor)

        yield* waitForSessions(gateway, 1)
        // Production wiring classifies raw close codes via sessionEndFromClose.
        const terminal = sessionEndFromClose(4004, "Unauthorized")
        expect(terminal._tag).toBe("TerminalCloseError")
        yield* gateway.endWith(0, terminal)

        yield* waitFor(supervisor.state.pipe(Effect.map((s) => s === "stopped")))
        expect(yield* supervisor.state).toBe("stopped")
        expect(yield* store.inspect).toMatchObject({
          clears: 1,
          session: null,
        })

        // Retry policy: no further attempts even with unlimited time.
        yield* TestClock.adjust(Duration.minutes(10))
        expect(yield* gateway.count).toBe(1)

        // Contrast: retryable closes stay below the terminal set.
        expect(sessionEndFromClose(4007, undefined)._tag).toBe("DisconnectedError")
      }),
  )

it.effect(
    "non-terminal disconnect retries with exponential capped full-jitter backoff (TestClock)",
    () =>
      Effect.gen(function* () {
        const gateway = yield* makeGateway
        const store = yield* makeStore
        // random = 1 → full-jitter delay equals the uncapped exponential value.
        const supervisor = yield* makeSupervisor(gateway, store)
        yield* fork(supervisor)

        // Every session dies instantly with a retryable disconnect.
        yield* waitForSessions(gateway, 1)
        yield* gateway.endWith(0, new DisconnectedError({ code: 1006 }))

        const expectedDelays = [0, 1, 2, 3, 4].map(
          (attempt) =>
            uncappedBackoffMillis(attempt, Duration.seconds(1), Duration.seconds(8)),
        )
        const observedDelays: Array<number> = []
        for (const _ of expectedDelays) {
          const delay = yield* nextRetryDelay(supervisor)
          observedDelays.push(delay)
          // Wake the sleeping loop and kill the fresh session it starts.
          yield* TestClock.adjust(Duration.millis(delay + 1))
          yield* gateway.endWith(observedDelays.length, new DisconnectedError({ code: 1006 }))
        }
        expect(observedDelays).toEqual([1000, 2000, 4000, 8000, 8000])
        expect(yield* gateway.count).toBeGreaterThanOrEqual(5)

        // Jitter scales below the cap: random = 0.25 quarters every delay.
        const gatewayB = yield* makeGateway
        const supervisorB = yield* make(
          {
            acquire: gatewayB.acquire,
            loadSession: store.load,
            saveSession: store.save,
            clearSession: store.clear,
          },
          {
            initialBackoff: Duration.seconds(1),
            maxBackoff: Duration.seconds(8),
            random: Effect.succeed(0.25),
          },
        )
        yield* fork(supervisorB)
        yield* waitForSessions(gatewayB, 1)
        yield* gatewayB.endWith(0, new DisconnectedError({}))
        expect(yield* nextRetryDelay(supervisorB)).toBe(250)
      }),
  )

it.effect("deploy-churn grace resets escalation right after establishment", () =>
    Effect.gen(function* () {
      const gateway = yield* makeGateway
      const store = yield* makeStore
      const supervisor = yield* makeSupervisor(gateway, store)
      yield* fork(supervisor)

      const ready = (n: number, seq: number) =>
        gateway.emitOn(n, {
          _tag: "Ready",
          session: { sessionId: "g1", sequence: seq },
        })

      // Drop #1, 5s after READY — inside the default 30s grace window.
      yield* waitForSessions(gateway, 1)
      yield* ready(0, 0)
      yield* waitFor(supervisor.state.pipe(Effect.map((s) => s === "ready")))
      yield* TestClock.adjust(Duration.seconds(5))
      yield* gateway.endWith(0, new DisconnectedError({}))
      // Grace reset ⇒ delay stays at base despite this being a retry.
      expect(yield* nextRetryDelay(supervisor)).toBe(1000)

      // Drop #2, also inside grace ⇒ STILL base delay (escalation did not
      // move; without the establishedAt fix this would be 2000).
      yield* TestClock.adjust(Duration.millis(1001))
      yield* waitForSessions(gateway, 2)
      yield* ready(1, 1)
      yield* waitFor(supervisor.state.pipe(Effect.map((s) => s === "ready")))
      yield* TestClock.adjust(Duration.seconds(5))
      yield* gateway.endWith(1, new DisconnectedError({}))
      expect(yield* nextRetryDelay(supervisor)).toBe(1000)

      // Drop #3 AFTER the grace window: escalation finally proceeds.
      yield* TestClock.adjust(Duration.millis(1001))
      yield* waitForSessions(gateway, 3)
      yield* ready(2, 2)
      yield* waitFor(supervisor.state.pipe(Effect.map((s) => s === "ready")))
      yield* TestClock.adjust(Duration.seconds(45)) // > 30s since READY
      yield* gateway.endWith(2, new DisconnectedError({}))
      expect(yield* nextRetryDelay(supervisor)).toBe(2000)
    }),
  )

it.effect("crash while connecting recovers: defect becomes retryable disconnect", () =>
    Effect.gen(function* () {
      const gateway = yield* makeGateway
      const store = yield* makeStore
      const supervisor = yield* makeSupervisor(gateway, store)
      yield* fork(supervisor)

      // Session #0's underlying fiber crashes mid-handshake (no READY yet).
      yield* waitForSessions(gateway, 1)
      expect(yield* supervisor.state).toBe("connecting")
      yield* gateway.crash(0)

      // Backoff (random=1 → 1s), then a fresh attempt that goes ready.
      expect(yield* nextRetryDelay(supervisor)).toBe(1000)
      yield* TestClock.adjust(Duration.seconds(2))
      yield* waitForSessions(gateway, 2)
      expect(yield* supervisor.state).toBe("connecting")

      yield* gateway.emitOn(1, {
        _tag: "Ready",
        session: { sessionId: "ok", sequence: 0 },
      })
      yield* waitFor(supervisor.state.pipe(Effect.map((s) => s === "ready")))
      expect(yield* supervisor.state).toBe("ready")
    }),
  )

it.effect("double start() runs a single supervision loop", () =>
  Effect.gen(function* () {
    const gateway = yield* makeGateway
    const store = yield* makeStore
    const supervisor = yield* makeSupervisor(gateway, store)

    // Two overlapping starts must claim the slot once.
    yield* Effect.all([supervisor.start, supervisor.start], {
      discard: true,
    })
    yield* waitForSessions(gateway, 1)
    for (let n = 0; n < 20; n++) yield* Effect.yieldNow
    expect(yield* gateway.count).toBe(1)

    // stop() releases the slot so a later start can run again.
    yield* supervisor.stop
    yield* supervisor.start
    yield* waitForSessions(gateway, 2)
    yield* supervisor.stop
  }),
)

it.effect("close-code classification mirrors dfx patch boundaries", () =>
    Effect.sync(() => {
      for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
        expect(sessionEndFromClose(code, undefined)._tag).toBe("TerminalCloseError")
      }
      for (const code of [1000, 1006, 4000, 4007, 4009, 4015]) {
        const result = sessionEndFromClose(code, undefined)
        expect(result._tag).toBe("DisconnectedError")
        if (result._tag === "DisconnectedError") expect(result.code).toBe(code)
      }
      expect(sessionEndFromClose(undefined, "no code")._tag).toBe("DisconnectedError")
    }),
  )

// ---------------------------------------------------------------------------
// dfx Shard acquire seam: lifecycle translation + shared state sync
// ---------------------------------------------------------------------------


interface FakeDfxState {
  readonly resumeUrl: string
  readonly sequence: number | null
  readonly sessionId: string
}

const emptyDfxState: FakeDfxState = { resumeUrl: '', sessionId: '', sequence: null }

it.effect('acquire seam syncs the shared store and translates lifecycle into SessionEvents', () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<FakeDfxState>({ ...emptyDfxState })
    const events: Array<SessionEvent> = []
    // The fake lifecycle stream terminates via a poison pill: Queue.shutdown
    // would interrupt a pending take and race the final Disconnected event.
    type FakeLifecycle = LifecycleEventLike | { readonly _tag: 'Stop' }
    const lifecycle = yield* Queue.unbounded<FakeLifecycle>()

    const emit = (event: SessionEvent) =>
      Effect.sync(() => {
        events.push(event)
      })

    // IDENTIFY clears the shared store so dfx identifies freshly.
    let handle: SessionHandle = yield* makeShardAcquire({
      shard: [0, 1] as const,
      connect: () =>
        Effect.succeed({
          lifecycle: Stream.takeWhile(
            Stream.fromQueue(lifecycle),
            (event): event is LifecycleEventLike => event._tag !== 'Stop',
          ),
        }),
      loadShardState: Ref.get(state),
      saveShardState: (next) => Ref.set(state, next),
      clearShardState: Ref.set(state, { ...emptyDfxState }),
    })({ _tag: 'Identify' }, emit)
    expect(yield* Ref.get(state)).toEqual(emptyDfxState)

    const joined = yield* Effect.forkScoped(handle.join)
    yield* Queue.offer(lifecycle, { _tag: 'Ready', shardId: 0 })
    yield* Effect.yieldNow
    // READY reads the session dfx persisted BEFORE publishing the dispatch.
    expect(events).toEqual([{ _tag: 'Ready', session: { sessionId: '', sequence: 0 } }])

    // RESUMED carries the persisted resume URL through to the supervisor.
    yield* Ref.set(state, { resumeUrl: 'wss://resume', sessionId: 's1', sequence: 9 })
    yield* Queue.offer(lifecycle, { _tag: 'Resumed', shardId: 0 })
    yield* Effect.yieldNow
    expect(events.slice(-1)).toEqual([
      { _tag: 'Resumed', session: { sessionId: 's1', sequence: 9, resumeUrl: 'wss://resume' } },
    ])

    // Disconnected ends the session with a classified failure.
    yield* Queue.offer(lifecycle, { _tag: 'Disconnected', shardId: 0, code: 4004 })
    yield* Queue.offer(lifecycle, { _tag: 'Stop' })
    const exit = yield* Effect.exit(Fiber.join(joined))
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      // v4 Cause has no failureOption; findFail surfaces the failed error.
      const foundFail = Cause.findFail(exit.cause)
      expect(Result.isSuccess(foundFail)).toBe(true)
      if (Result.isSuccess(foundFail)) {
        expect(foundFail.success.error._tag).toBe('TerminalCloseError')
      }
    }
  }))

it.effect('acquire seam forwards dispatch payloads to onDispatch and stops with the session', () =>
  Effect.gen(function* () {
    const seen: Array<unknown> = []
    type FakeLifecycle = LifecycleEventLike | { readonly _tag: 'Stop' }
    const lifecycle = yield* Queue.unbounded<FakeLifecycle>()
    const dispatches = yield* Queue.unbounded<unknown>()

    let handle: SessionHandle = yield* makeShardAcquire({
      shard: [0, 1] as const,
      connect: () =>
        Effect.succeed({
          lifecycle: Stream.takeWhile(
            Stream.fromQueue(lifecycle),
            (event): event is LifecycleEventLike => event._tag !== 'Stop',
          ),
          dispatches: Stream.fromQueue(dispatches),
        }),
      loadShardState: Effect.succeed(undefined),
      saveShardState: () => Effect.void,
      clearShardState: Effect.void,
      onDispatch: (payload) =>
        Effect.sync(() => {
          seen.push(payload)
        }),
    })({ _tag: 'Identify' }, () => Effect.void)

    const joined = yield* Effect.forkScoped(handle.join)
    yield* Queue.offer(dispatches, { t: 'MESSAGE_CREATE', d: { id: '1' } })
    yield* Queue.offer(dispatches, { t: 'TYPING_START', d: {} })
    // The dispatch pump runs concurrently; spin until both payloads landed.
    let spins = 0
    while (seen.length < 2 && spins < 100) {
      yield* Effect.yieldNow
      spins += 1
    }
    expect(seen).toEqual([
      { t: 'MESSAGE_CREATE', d: { id: '1' } },
      { t: 'TYPING_START', d: {} },
    ])

    // Session end interrupts the dispatch pump: no payload survives the socket.
    yield* Queue.offer(lifecycle, { _tag: 'Disconnected', shardId: 0, code: 1006 })
    yield* Queue.offer(lifecycle, { _tag: 'Stop' })
    yield* Effect.exit(Fiber.join(joined))
    const countBefore = seen.length
    yield* Queue.offer(dispatches, { t: 'MESSAGE_CREATE', d: { id: '2' } })
    for (let n = 0; n < 20; n++) yield* Effect.yieldNow
    expect(seen.length).toBe(countBefore)
  }))
