import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"

export type GatewayAttemptMode = "identify" | "resume"

/**
 * Content-free gateway observations. These deliberately contain no Discord
 * payloads, message/guild/channel IDs, close reasons, or credentials.
 */
export type GatewayObservation =
  | {
      readonly _tag: "Activated"
      readonly activationId: string
      readonly at: number
    }
  | {
      readonly _tag: "AttemptStarted"
      readonly activationId: string
      readonly at: number
      readonly attempt: number
      readonly mode: GatewayAttemptMode
    }
  | {
      readonly _tag: "Ready"
      readonly activationId: string
      readonly at: number
      readonly attempt: number
    }
  | {
      readonly _tag: "Resumed"
      readonly activationId: string
      readonly at: number
      readonly attempt: number
    }
  | {
      readonly _tag: "Disconnected"
      readonly activationId: string
      readonly at: number
      readonly attempt: number
    }
  | {
      readonly _tag: "HeartbeatAck"
      readonly activationId: string
      readonly at: number
      readonly attempt: number
    }
  | {
      readonly _tag: "TerminalClose"
      readonly activationId: string
      readonly at: number
      readonly attempt: number
      readonly code: number
    }
  | {
      readonly _tag: "AlarmObserved"
      readonly activationId: string
      readonly at: number
      readonly lagMs: number
    }

export type GatewayConnectionState =
  | "activated"
  | "connecting"
  | "ready"
  | "disconnected"
  | "terminal"

export type GatewayLastError = "disconnected" | "terminal-close" | null

export interface GatewayTelemetryLifetime {
  readonly attempts: number
  readonly identifies: number
  readonly resumes: number
  readonly reconnects: number
  readonly terminalCloses: number
  readonly lastReadyAt: number | null
  readonly lastResumedAt: number | null
  readonly lastDisconnectedAt: number | null
  readonly lastHeartbeatAckAt: number | null
}

export interface GatewayTelemetryCurrent {
  readonly activationId: string
  readonly state: GatewayConnectionState
  readonly attempt: number
  readonly connectedAt: number | null
  readonly lastReadyAt: number | null
  readonly lastResumedAt: number | null
  readonly lastDisconnectedAt: number | null
  readonly lastHeartbeatAckAt: number | null
  readonly terminalCloseCode: number | null
  readonly alarmLagMs: number | null
  readonly lastError: GatewayLastError
}

/** One bounded durable aggregate: lifetime soak data plus current health. */
export interface GatewayTelemetrySnapshot {
  readonly lifetime: GatewayTelemetryLifetime
  readonly current: GatewayTelemetryCurrent
}

/**
 * Persistence boundary for a Durable Object implementation. `append` folds
 * the observation into the one durable aggregate before it completes;
 * `aggregate` reads that value. The gateway lifecycle never sees storage keys
 * or a concrete KV implementation.
 */
export interface GatewayTelemetrySink {
  readonly append: (observation: GatewayObservation) => Effect.Effect<void>
  readonly aggregate: Effect.Effect<GatewayTelemetrySnapshot | null>
}

export interface GatewayTelemetryRecorder {
  readonly activationId: string
  readonly activated: Effect.Effect<void>
  readonly attemptStarted: (
    attempt: number,
    mode: GatewayAttemptMode,
  ) => Effect.Effect<void>
  readonly ready: (attempt: number) => Effect.Effect<void>
  readonly resumed: (attempt: number) => Effect.Effect<void>
  readonly disconnected: (attempt: number) => Effect.Effect<void>
  /** DFX currently does not expose ACKs; this is ready for a future adapter. */
  readonly heartbeatAck: (attempt: number) => Effect.Effect<void>
  readonly terminalClose: (attempt: number, code: number) => Effect.Effect<void>
  readonly alarmObserved: (lagMs: number) => Effect.Effect<void>
  readonly aggregate: Effect.Effect<GatewayTelemetrySnapshot | null>
  readonly health: Effect.Effect<GatewayHealthPredicateData | null>
}

export interface GatewayHealthPredicateData {
  readonly activationId: string
  readonly state: GatewayConnectionState
  readonly connected: boolean
  readonly established: boolean
  readonly terminal: boolean
  readonly lastEstablishedAt: number | null
  readonly connectionAgeMs: number | null
  readonly heartbeatAckAgeMs: number | null
  readonly alarmLagMs: number | null
  readonly lastError: GatewayLastError
}

const later = (current: number | null, next: number): number =>
  current === null ? next : Math.max(current, next)

const age = (now: number, timestamp: number | null): number | null =>
  timestamp === null ? null : Math.max(0, now - timestamp)

export const emptyGatewayTelemetrySnapshot = (
  activationId: string,
): GatewayTelemetrySnapshot => ({
  lifetime: {
    attempts: 0,
    identifies: 0,
    resumes: 0,
    reconnects: 0,
    terminalCloses: 0,
    lastReadyAt: null,
    lastResumedAt: null,
    lastDisconnectedAt: null,
    lastHeartbeatAckAt: null,
  },
  current: {
    activationId,
    state: "activated",
    attempt: 0,
    connectedAt: null,
    lastReadyAt: null,
    lastResumedAt: null,
    lastDisconnectedAt: null,
    lastHeartbeatAckAt: null,
    terminalCloseCode: null,
    alarmLagMs: null,
    lastError: null,
  },
})

/** Pure aggregate reducer shared by durable and in-memory sinks. */
export const reduceGatewayObservation = (
  current: GatewayTelemetrySnapshot | null,
  observation: GatewayObservation,
): GatewayTelemetrySnapshot => {
  const snapshot = current ?? emptyGatewayTelemetrySnapshot(observation.activationId)
  // `Activated` is the ownership handoff. Once an activation owns the
  // aggregate, late events from a stopped predecessor are stale and must not
  // reclaim it or restore predecessor terminal/connection state.
  if (
    current !== null &&
    observation._tag !== "Activated" &&
    observation.activationId !== current.current.activationId
  ) {
    return current
  }

  switch (observation._tag) {
    case "Activated":
      return snapshot.current.activationId === observation.activationId
        ? snapshot
        : {
            lifetime: snapshot.lifetime,
            current: emptyGatewayTelemetrySnapshot(observation.activationId).current,
          }
    case "AttemptStarted":
      return {
        lifetime: {
          ...snapshot.lifetime,
          attempts: snapshot.lifetime.attempts + 1,
          identifies:
            snapshot.lifetime.identifies +
            (observation.mode === "identify" ? 1 : 0),
          resumes:
            snapshot.lifetime.resumes +
            (observation.mode === "resume" ? 1 : 0),
        },
        current: {
          ...snapshot.current,
          state: "connecting",
          attempt: Math.max(snapshot.current.attempt, observation.attempt),
        },
      }
    case "Ready":
      return {
        lifetime: {
          ...snapshot.lifetime,
          lastReadyAt: later(snapshot.lifetime.lastReadyAt, observation.at),
        },
        current: {
          ...snapshot.current,
          state: "ready",
          attempt: Math.max(snapshot.current.attempt, observation.attempt),
          connectedAt: observation.at,
          lastReadyAt: later(snapshot.current.lastReadyAt, observation.at),
          terminalCloseCode: null,
          lastError: null,
        },
      }
    case "Resumed":
      return {
        lifetime: {
          ...snapshot.lifetime,
          lastResumedAt: later(
            snapshot.lifetime.lastResumedAt,
            observation.at,
          ),
        },
        current: {
          ...snapshot.current,
          state: "ready",
          attempt: Math.max(snapshot.current.attempt, observation.attempt),
          connectedAt: observation.at,
          lastResumedAt: later(snapshot.current.lastResumedAt, observation.at),
          terminalCloseCode: null,
          lastError: null,
        },
      }
    case "Disconnected":
      return {
        lifetime: {
          ...snapshot.lifetime,
          lastDisconnectedAt: later(
            snapshot.lifetime.lastDisconnectedAt,
            observation.at,
          ),
          reconnects: snapshot.lifetime.reconnects + 1,
        },
        current: {
          ...snapshot.current,
          state: "disconnected",
          attempt: Math.max(snapshot.current.attempt, observation.attempt),
          connectedAt: null,
          lastDisconnectedAt: later(
            snapshot.current.lastDisconnectedAt,
            observation.at,
          ),
          lastError: "disconnected",
        },
      }
    case "HeartbeatAck":
      return {
        lifetime: {
          ...snapshot.lifetime,
          lastHeartbeatAckAt: later(
            snapshot.lifetime.lastHeartbeatAckAt,
            observation.at,
          ),
        },
        current: {
          ...snapshot.current,
          attempt: Math.max(snapshot.current.attempt, observation.attempt),
          lastHeartbeatAckAt: later(
            snapshot.current.lastHeartbeatAckAt,
            observation.at,
          ),
        },
      }
    case "TerminalClose":
      return {
        lifetime: {
          ...snapshot.lifetime,
          terminalCloses: snapshot.lifetime.terminalCloses + 1,
          lastDisconnectedAt: later(
            snapshot.lifetime.lastDisconnectedAt,
            observation.at,
          ),
        },
        current: {
          ...snapshot.current,
          state: "terminal",
          attempt: Math.max(snapshot.current.attempt, observation.attempt),
          connectedAt: null,
          terminalCloseCode: observation.code,
          lastDisconnectedAt: later(
            snapshot.current.lastDisconnectedAt,
            observation.at,
          ),
          lastError: "terminal-close",
        },
      }
    case "AlarmObserved":
      return {
        ...snapshot,
        current: {
          ...snapshot.current,
          alarmLagMs: Math.max(0, observation.lagMs),
        },
      }
  }
}

/** Threshold-free facts from which BotStatus can apply its own health policy. */
export const gatewayHealthPredicateData = (
  snapshot: GatewayTelemetrySnapshot,
  now: number,
): GatewayHealthPredicateData => {
  const { current } = snapshot
  const lastEstablishedAt =
    current.lastReadyAt === null
      ? current.lastResumedAt
      : current.lastResumedAt === null
        ? current.lastReadyAt
        : Math.max(current.lastReadyAt, current.lastResumedAt)
  const connected = current.state === "ready" && current.connectedAt !== null

  return {
    activationId: current.activationId,
    state: current.state,
    connected,
    established: lastEstablishedAt !== null,
    terminal: current.state === "terminal",
    lastEstablishedAt,
    connectionAgeMs: age(now, current.connectedAt),
    heartbeatAckAgeMs: age(now, current.lastHeartbeatAckAt),
    alarmLagMs: current.alarmLagMs,
    lastError: current.lastError,
  }
}

export const makeGatewayTelemetryRecorder = (
  activationId: string,
  sink: GatewayTelemetrySink,
  now: Effect.Effect<number> = Clock.currentTimeMillis,
): GatewayTelemetryRecorder => {
  const appendAt = <TObservation extends GatewayObservation>(
    make: (at: number) => TObservation,
  ) => Effect.flatMap(now, (at) => sink.append(make(at)))

  return {
    activationId,
    activated: appendAt((at) => ({ _tag: "Activated", activationId, at })),
    attemptStarted: (attempt, mode) =>
      appendAt((at) => ({
        _tag: "AttemptStarted",
        activationId,
        at,
        attempt,
        mode,
      })),
    ready: (attempt) =>
      appendAt((at) => ({ _tag: "Ready", activationId, at, attempt })),
    resumed: (attempt) =>
      appendAt((at) => ({ _tag: "Resumed", activationId, at, attempt })),
    disconnected: (attempt) =>
      appendAt((at) => ({
        _tag: "Disconnected",
        activationId,
        at,
        attempt,
      })),
    heartbeatAck: (attempt) =>
      appendAt((at) => ({
        _tag: "HeartbeatAck",
        activationId,
        at,
        attempt,
      })),
    terminalClose: (attempt, code) =>
      appendAt((at) => ({
        _tag: "TerminalClose",
        activationId,
        at,
        attempt,
        code,
      })),
    alarmObserved: (lagMs) =>
      appendAt((at) => ({
        _tag: "AlarmObserved",
        activationId,
        at,
        lagMs,
      })),
    aggregate: sink.aggregate,
    health: Effect.flatMap(sink.aggregate, (snapshot) =>
      snapshot === null
        ? Effect.succeed(null)
        : Effect.map(now, (current) =>
            gatewayHealthPredicateData(snapshot, current),
          ),
    ),
  }
}

export type InMemoryGatewayTelemetrySink = GatewayTelemetrySink

/** Bounded in-memory test/reference sink; it retains no observation log. */
export const makeInMemoryGatewayTelemetrySink = Effect.gen(function* () {
  const aggregate = yield* Ref.make<GatewayTelemetrySnapshot | null>(null)

  return {
    append: (observation) =>
      Ref.update(aggregate, (current) =>
        reduceGatewayObservation(current, observation),
      ),
    aggregate: Ref.get(aggregate),
  } satisfies InMemoryGatewayTelemetrySink
})
