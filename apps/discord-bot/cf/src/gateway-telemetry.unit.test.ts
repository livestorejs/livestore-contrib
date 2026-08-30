import { expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"

import {
  makeGatewayTelemetryRecorder,
  makeInMemoryGatewayTelemetrySink,
  type GatewayObservation,
  type GatewayTelemetrySink,
} from "./gateway-telemetry.ts"
import {
  make,
  makeShardAcquire,
  TerminalCloseError,
  type LifecycleEventLike,
} from "./supervisor.ts"

const waitFor = (predicate: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (;;) {
      if ((yield* predicate) === true) return
      yield* Effect.yieldNow
    }
  })

it.effect("terminal RunningShard.failure halts supervision and clears the session", () =>
  Effect.gen(function* () {
    const now = yield* Ref.make(1_000)
    const sink = yield* makeInMemoryGatewayTelemetrySink
    const telemetry = makeGatewayTelemetryRecorder("activation-a", sink, Ref.get(now))
    const clears = yield* Ref.make(0)

    const acquire = makeShardAcquire({
      shard: [0, 1],
      connect: () =>
        Effect.succeed({
          lifecycle: Stream.never,
          failure: Effect.fail({ code: 4004, reason: "not persisted" }),
        }),
      loadShardState: Effect.succeed(undefined),
      saveShardState: () => Effect.void,
      clearShardState: Effect.void,
    })
    const supervisor = yield* make(
      {
        acquire,
        loadSession: Effect.succeed({ sessionId: "stored", sequence: 2 }),
        saveSession: () => Effect.void,
        clearSession: Ref.update(clears, (count) => count + 1),
      },
      {
        initialBackoff: Duration.millis(1),
        maxBackoff: Duration.millis(1),
        random: Effect.succeed(0),
        telemetry,
      },
    )

    yield* supervisor.run

    expect(yield* supervisor.state).toBe("stopped")
    expect(yield* Ref.get(clears)).toBe(1)
    expect(yield* telemetry.aggregate).toMatchObject({
      lifetime: {
        attempts: 1,
        resumes: 1,
        reconnects: 0,
        terminalCloses: 1,
        lastDisconnectedAt: 1_000,
      },
      current: {
        activationId: "activation-a",
        state: "terminal",
        attempt: 1,
        terminalCloseCode: 4004,
      },
    })
  }),
)

it.effect("withdraws readiness before a terminal checkpoint save can finish", () =>
  Effect.gen(function* () {
    const sessionEnd = yield* Deferred.make<void, TerminalCloseError>()
    const saveStarted = yield* Deferred.make<void>()
    const allowSave = yield* Deferred.make<void>()
    const clears = yield* Ref.make(0)

    const supervisor = yield* make(
      {
        acquire: (_mode, emit) =>
          Effect.gen(function* () {
            yield* emit({
              _tag: "Ready",
              session: { sessionId: "session", sequence: 1 },
            })
            return { join: Deferred.await(sessionEnd) }
          }),
        loadSession: Effect.succeed(null),
        saveSession: () =>
          Deferred.succeed(saveStarted, void 0).pipe(
            Effect.andThen(Deferred.await(allowSave)),
          ),
        clearSession: Ref.update(clears, (count) => count + 1),
      },
      {
        initialBackoff: Duration.millis(1),
        maxBackoff: Duration.millis(1),
        random: Effect.succeed(0),
      },
    )

    const runner = yield* Effect.forkScoped(supervisor.run)
    yield* Deferred.await(saveStarted)
    expect(yield* supervisor.state).toBe("ready")

    yield* Deferred.fail(sessionEnd, new TerminalCloseError({ code: 4004 }))
    yield* waitFor(Effect.map(supervisor.state, (state) => state === "disconnected"))
    expect(yield* Ref.get(clears)).toBe(0)

    yield* Deferred.succeed(allowSave, void 0)
    yield* Fiber.join(runner)
    expect(yield* supervisor.state).toBe("stopped")
    expect(yield* Ref.get(clears)).toBe(1)
  }),
)

it.effect("retryable RunningShard.failure ends the attempt and reconnects", () =>
  Effect.gen(function* () {
    const sink = yield* makeInMemoryGatewayTelemetrySink
    const telemetry = makeGatewayTelemetryRecorder(
      "activation-retry",
      sink,
      Effect.succeed(2_000),
    )
    const connects = yield* Ref.make(0)

    const acquire = makeShardAcquire({
      shard: [0, 1],
      connect: () =>
        Ref.getAndUpdate(connects, (count) => count + 1).pipe(
          Effect.map((count) => ({
            lifecycle: Stream.never,
            failure:
              count === 0
                ? Effect.fail({ code: 1006 })
                : Effect.never,
          })),
        ),
      loadShardState: Effect.succeed(undefined),
      saveShardState: () => Effect.void,
      clearShardState: Effect.void,
    })
    const supervisor = yield* make(
      {
        acquire,
        loadSession: Effect.succeed(null),
        saveSession: () => Effect.void,
        clearSession: Effect.void,
      },
      {
        initialBackoff: Duration.millis(1),
        maxBackoff: Duration.millis(1),
        random: Effect.succeed(0),
        telemetry,
      },
    )

    const runner = yield* Effect.forkScoped(supervisor.run)
    yield* waitFor(Effect.map(Ref.get(connects), (count) => count === 2))

    expect(yield* supervisor.state).toBe("connecting")
    expect(yield* telemetry.aggregate).toMatchObject({
      lifetime: {
        attempts: 2,
        identifies: 2,
        resumes: 0,
        reconnects: 1,
        terminalCloses: 0,
      },
      current: {
        state: "connecting",
        attempt: 2,
        terminalCloseCode: null,
      },
    })
    yield* Fiber.interrupt(runner)
  }),
)

it.effect("inner DFX reconnect withdraws health until RESUMED without restarting", () =>
  Effect.gen(function* () {
    const lifecycle = yield* Queue.unbounded<LifecycleEventLike>()
    const shardState = yield* Ref.make({
      resumeUrl: "",
      sessionId: "",
      sequence: null as number | null,
    })
    const connects = yield* Ref.make(0)
    const sink = yield* makeInMemoryGatewayTelemetrySink
    const telemetry = makeGatewayTelemetryRecorder(
      "activation-inner-reconnect",
      sink,
      Effect.succeed(5_000),
    )
    yield* telemetry.activated

    const acquire = makeShardAcquire({
      shard: [0, 1],
      connect: () =>
        Ref.update(connects, (count) => count + 1).pipe(
          Effect.as({
            lifecycle: Stream.fromQueue(lifecycle),
            failure: Effect.never,
          }),
        ),
      loadShardState: Ref.get(shardState),
      saveShardState: (next) => Ref.set(shardState, next),
      clearShardState: Ref.set(shardState, {
        resumeUrl: "",
        sessionId: "",
        sequence: null,
      }),
    })
    const supervisor = yield* make(
      {
        acquire,
        loadSession: Effect.succeed(null),
        saveSession: () => Effect.void,
        clearSession: Effect.void,
      },
      {
        initialBackoff: Duration.millis(1),
        maxBackoff: Duration.millis(1),
        random: Effect.succeed(0),
        telemetry,
      },
    )

    const runner = yield* Effect.forkScoped(supervisor.run)
    yield* waitFor(Effect.map(Ref.get(connects), (count) => count === 1))
    yield* Ref.set(shardState, {
      resumeUrl: "wss://resume",
      sessionId: "session",
      sequence: 1,
    })
    yield* Queue.offer(lifecycle, { _tag: "Ready", shardId: 0 })
    yield* waitFor(Effect.map(telemetry.health, (health) => health?.connected === true))
    expect(yield* supervisor.state).toBe("ready")

    yield* Queue.offer(lifecycle, {
      _tag: "Disconnected",
      shardId: 0,
      code: 1006,
      retryable: true,
    })
    yield* waitFor(Effect.map(telemetry.health, (health) => health?.connected === false))
    expect(yield* supervisor.state).toBe("disconnected")
    expect(yield* Ref.get(connects)).toBe(1)

    yield* Ref.set(shardState, {
      resumeUrl: "wss://resume",
      sessionId: "session",
      sequence: 2,
    })
    yield* Queue.offer(lifecycle, { _tag: "Resumed", shardId: 0 })
    yield* waitFor(Effect.map(telemetry.health, (health) => health?.connected === true))
    expect(yield* supervisor.state).toBe("ready")
    expect(yield* Ref.get(connects)).toBe(1)
    expect(yield* telemetry.aggregate).toMatchObject({
      lifetime: {
        attempts: 1,
        reconnects: 1,
        lastDisconnectedAt: 5_000,
        lastResumedAt: 5_000,
      },
      current: {
        state: "ready",
        connectedAt: 5_000,
        lastDisconnectedAt: 5_000,
        lastResumedAt: 5_000,
        lastError: null,
      },
    })
    yield* Fiber.interrupt(runner)
  }),
)

it.effect("durable counters and timestamps are monotonic", () =>
  Effect.gen(function* () {
    const now = yield* Ref.make(10)
    const sink = yield* makeInMemoryGatewayTelemetrySink
    const telemetry = makeGatewayTelemetryRecorder("activation-counters", sink, Ref.get(now))

    yield* telemetry.activated
    yield* telemetry.attemptStarted(1, "identify")
    yield* telemetry.ready(1)
    const first = yield* telemetry.aggregate

    yield* Ref.set(now, 20)
    yield* telemetry.disconnected(1)
    yield* telemetry.attemptStarted(2, "resume")
    yield* telemetry.resumed(2)
    yield* telemetry.heartbeatAck(2)
    yield* telemetry.alarmObserved(17)
    const second = yield* telemetry.aggregate

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (first === null || second === null) return
    expect(second.current.attempt).toBeGreaterThanOrEqual(first.current.attempt)
    expect(second.lifetime.attempts).toBeGreaterThanOrEqual(first.lifetime.attempts)
    expect(second.lifetime.identifies).toBeGreaterThanOrEqual(first.lifetime.identifies)
    expect(second.lifetime.resumes).toBeGreaterThanOrEqual(first.lifetime.resumes)
    expect(second.lifetime.reconnects).toBeGreaterThanOrEqual(first.lifetime.reconnects)
    expect(second.lifetime.lastReadyAt).toBeGreaterThanOrEqual(
      first.lifetime.lastReadyAt ?? 0,
    )
    expect(second).toMatchObject({
      lifetime: {
        attempts: 2,
        identifies: 1,
        resumes: 1,
        reconnects: 1,
        lastReadyAt: 10,
        lastResumedAt: 20,
        lastDisconnectedAt: 20,
        lastHeartbeatAckAt: 20,
      },
      current: {
        state: "ready",
        connectedAt: 20,
        lastResumedAt: 20,
        lastDisconnectedAt: 20,
        lastHeartbeatAckAt: 20,
        alarmLagMs: 17,
      },
    })
    expect(yield* telemetry.health).toEqual({
      activationId: "activation-counters",
      state: "ready",
      connected: true,
      established: true,
      terminal: false,
      lastEstablishedAt: 20,
      connectionAgeMs: 0,
      heartbeatAckAgeMs: 0,
      alarmLagMs: 17,
      lastError: null,
    })
  }),
)

it.effect("late predecessor events cannot reclaim a newer activation", () =>
  Effect.gen(function* () {
    const sink = yield* makeInMemoryGatewayTelemetrySink
    const oldActivation = makeGatewayTelemetryRecorder(
      "activation-old",
      sink,
      Effect.succeed(40),
    )
    const newActivation = makeGatewayTelemetryRecorder(
      "activation-new",
      sink,
      Effect.succeed(50),
    )

    yield* oldActivation.activated
    yield* oldActivation.attemptStarted(1, "identify")
    yield* oldActivation.ready(1)
    yield* oldActivation.terminalClose(1, 4004)
    expect(yield* oldActivation.aggregate).toMatchObject({
      lifetime: {
        attempts: 1,
        identifies: 1,
        terminalCloses: 1,
        lastReadyAt: 40,
        lastDisconnectedAt: 40,
      },
      current: {
        activationId: "activation-old",
        state: "terminal",
        terminalCloseCode: 4004,
      },
    })

    // Ownership moves before the predecessor finishes its shutdown
    // observations. Those stale writes cannot mutate the active aggregate or
    // restore the predecessor's terminal state.
    yield* newActivation.activated
    yield* oldActivation.attemptStarted(2, "resume")
    yield* oldActivation.disconnected(2)
    yield* oldActivation.terminalClose(2, 4014)
    expect(yield* newActivation.aggregate).toMatchObject({
      lifetime: {
        attempts: 1,
        identifies: 1,
        resumes: 0,
        reconnects: 0,
        terminalCloses: 1,
        lastReadyAt: 40,
        lastDisconnectedAt: 40,
      },
      current: {
        activationId: "activation-new",
        state: "activated",
        attempt: 0,
        connectedAt: null,
        lastReadyAt: null,
        lastResumedAt: null,
        lastDisconnectedAt: null,
        terminalCloseCode: null,
      },
    })

    yield* newActivation.attemptStarted(1, "resume")
    yield* newActivation.resumed(1)
    expect(yield* newActivation.aggregate).toMatchObject({
      lifetime: {
        attempts: 2,
        identifies: 1,
        resumes: 1,
        reconnects: 0,
        terminalCloses: 1,
      },
      current: {
        activationId: "activation-new",
        state: "ready",
        attempt: 1,
        connectedAt: 50,
        lastResumedAt: 50,
        terminalCloseCode: null,
      },
    })
  }),
)

it.effect("observations have only content-free fields", () =>
  Effect.gen(function* () {
    const observations: Array<GatewayObservation> = []
    const sink: GatewayTelemetrySink = {
      append: (observation) =>
        Effect.sync(() => {
          observations.push(observation)
        }),
      aggregate: Effect.succeed(null),
    }
    const telemetry = makeGatewayTelemetryRecorder(
      "activation-content-free",
      sink,
      Effect.succeed(30),
    )

    yield* telemetry.activated
    yield* telemetry.attemptStarted(1, "identify")
    yield* telemetry.ready(1)
    yield* telemetry.disconnected(1)
    yield* telemetry.heartbeatAck(1)
    yield* telemetry.terminalClose(1, 4014)
    yield* telemetry.alarmObserved(5)

    const allowedKeys: Record<GatewayObservation["_tag"], ReadonlyArray<string>> = {
      Activated: ["_tag", "activationId", "at"],
      AttemptStarted: ["_tag", "activationId", "at", "attempt", "mode"],
      Ready: ["_tag", "activationId", "at", "attempt"],
      Resumed: ["_tag", "activationId", "at", "attempt"],
      Disconnected: ["_tag", "activationId", "at", "attempt"],
      HeartbeatAck: ["_tag", "activationId", "at", "attempt"],
      TerminalClose: ["_tag", "activationId", "at", "attempt", "code"],
      AlarmObserved: ["_tag", "activationId", "at", "lagMs"],
    }

    for (const observation of observations) {
      expect(Object.keys(observation).sort()).toEqual(
        [...allowedKeys[observation._tag]].sort(),
      )
    }
    expect(JSON.stringify(observations)).not.toMatch(
      /payload|message|channel|guild|token|session|reason/i,
    )
  }),
)
