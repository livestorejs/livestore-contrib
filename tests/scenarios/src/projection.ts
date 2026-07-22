import { Schema } from '@livestore/utils/effect'

import {
  BackendObservation,
  ComponentSyncObservation,
  type ObservedEvent,
  OracleVerdict,
  type ScenarioAst,
  type ScenarioTraceRecord,
} from './model.ts'

export const ProjectedSession = Schema.Struct({
  sessionId: Schema.String,
  lifecycle: Schema.Literals(['declared', 'created', 'stopped']),
  health: Schema.Literals(['unknown', 'healthy', 'failed']),
  sync: Schema.NullOr(ComponentSyncObservation),
})
export type ProjectedSession = typeof ProjectedSession.Type

export const ProjectedClient = Schema.Struct({
  clientId: Schema.String,
  lifecycle: Schema.Literals(['declared', 'created']),
  health: Schema.Literals(['unknown', 'healthy', 'degraded', 'failed']),
  connected: Schema.NullOr(Schema.Boolean),
  leader: Schema.NullOr(ComponentSyncObservation),
  sessions: Schema.Array(ProjectedSession),
})
export type ProjectedClient = typeof ProjectedClient.Type

export const ObservedSystemState = Schema.Struct({
  cursorIndex: Schema.Finite,
  runStatus: Schema.Literals(['not-started', 'running', 'passed', 'failed']),
  activePhaseId: Schema.NullOr(Schema.String),
  backend: Schema.NullOr(BackendObservation),
  clients: Schema.Array(ProjectedClient),
  verdicts: Schema.Array(OracleVerdict),
})
export type ObservedSystemState = typeof ObservedSystemState.Type

export interface EventTimelineMarker {
  readonly recordIndex: number
  readonly componentKey: string
  readonly event: ObservedEvent
  readonly captureId: string
  readonly captureIndex: number
  readonly calibratedTime: ScenarioTraceRecord['calibratedTime']
}

export interface TraceCapture {
  readonly captureId: string
  readonly captureIndex: number
  readonly firstRecordIndex: number
  readonly lastRecordIndex: number
  readonly recordIndexes: ReadonlyArray<number>
}

export type ConnectivityBoundaryEvidence = 'explicit-transition' | 'first-observed'

export interface ConnectivityInterval {
  readonly clientId: string
  readonly startRecordIndex: number
  readonly endRecordIndex: number | null
  readonly startEvidence: ConnectivityBoundaryEvidence
  readonly endEvidence: ConnectivityBoundaryEvidence | null
}

export interface LaneActivityInterval {
  readonly componentKey: string
  readonly startRecordIndex: number
  readonly endRecordIndex: number | null
}

export interface RuntimeFailureInterval {
  readonly componentKey: string
  readonly clientId: string
  readonly sessionId: string | null
  readonly startRecordIndex: number
  readonly endRecordIndex: number | null
  readonly recordIndexes: ReadonlyArray<number>
  readonly summary: string
}

export type PlaybackMomentKind =
  | 'run'
  | 'action'
  | 'topology'
  | 'connectivity'
  | 'lifecycle'
  | 'capture'
  | 'settlement'
  | 'failure'

export interface PlaybackMoment {
  readonly momentIndex: number
  readonly recordIndex: number
  readonly recordIndexes: ReadonlyArray<number>
  readonly captureId: string | null
  readonly kind: PlaybackMomentKind
  readonly label: string
  readonly summary: string
}

export interface ExplicitCausalEdge {
  readonly fromRecordIndex: number
  readonly toRecordIndex: number
}

export interface ScenarioOperationHistoryEntry {
  readonly operationId: string
  readonly invocationRecordIndex: number
  readonly outcomeRecordIndex: number | null
  readonly status: 'pending' | 'succeeded' | 'definite-failure' | 'indefinite'
}

export interface TimeScalePoint {
  readonly timeMs: number
  readonly position: number
}

export interface CompressedTimeGap {
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly startPosition: number
  readonly endPosition: number
}

export interface AdaptiveTimeLayout {
  readonly points: ReadonlyArray<TimeScalePoint>
  readonly compressedGaps: ReadonlyArray<CompressedTimeGap>
}

/** Reduces the authoritative trace prefix into the runner's accumulated observed state. */
export const projectTraceAt = (args: {
  scenario: ScenarioAst
  trace: ReadonlyArray<ScenarioTraceRecord>
  cursorIndex: number
}): ObservedSystemState => {
  const cursorIndex = Math.min(Math.max(args.cursorIndex, -1), args.trace.length - 1)
  let state = initialObservedSystemState(args.scenario, cursorIndex)

  for (const record of args.trace.slice(0, cursorIndex + 1)) {
    state = applyTraceRecord(state, record)
  }

  return Schema.decodeUnknownSync(ObservedSystemState)(state)
}

/** Derives material navigation points while retaining a raw observation-index boundary for every moment. */
export const derivePlaybackMoments = (args: {
  scenario: ScenarioAst
  trace: ReadonlyArray<ScenarioTraceRecord>
}): ReadonlyArray<PlaybackMoment> => {
  const captures = deriveTraceCaptures(args.trace)
  const captureByLastRecord = new Map(captures.map((capture) => [capture.lastRecordIndex, capture]))
  const moments: Omit<PlaybackMoment, 'momentIndex'>[] = []
  let state = initialObservedSystemState(args.scenario, -1)
  let materialState = state
  let materialSignature = materialSystemSignature(state)

  for (const record of args.trace) {
    state = applyTraceRecord({ ...state, cursorIndex: record.index }, record)
    const kind = semanticMomentKind(record)
    if (kind !== undefined) {
      moments.push({
        recordIndex: record.index,
        recordIndexes: [record.index],
        captureId: null,
        kind,
        label: record.payload._tag,
        summary: summarizeTraceRecord(record),
      })
      materialState = state
      materialSignature = materialSystemSignature(state)
      continue
    }

    const capture = captureByLastRecord.get(record.index)
    if (capture === undefined) continue
    const nextSignature = materialSystemSignature(state)
    if (nextSignature === materialSignature) continue
    moments.push({
      recordIndex: capture.lastRecordIndex,
      recordIndexes: capture.recordIndexes,
      captureId: capture.captureId,
      kind: 'capture',
      label: `capture ${capture.captureIndex + 1} · ${capture.recordIndexes.length} records`,
      summary: summarizeMaterialSystemChange(materialState, state),
    })
    materialState = state
    materialSignature = nextSignature
  }

  return moments.map((moment, momentIndex) => ({ ...moment, momentIndex }))
}

/** Emits a marker only when one event's observed component position or disposition changes. */
export const deriveEventTimeline = (trace: ReadonlyArray<ScenarioTraceRecord>): ReadonlyArray<EventTimelineMarker> => {
  const previous = new Map<string, string>()
  const markers: EventTimelineMarker[] = []
  const captureIndexes = new Map(deriveTraceCaptures(trace).map((capture) => [capture.captureId, capture.captureIndex]))

  for (const record of trace) {
    const component = observationComponent(record)
    if (component === undefined || record.captureId === null) continue
    for (const event of component.events) {
      const key = `${component.key}\u0000${event.eventRef}`
      const signature = `${event.position}\u0000${event.parentPosition}\u0000${event.disposition}`
      if (previous.get(key) === signature) continue
      previous.set(key, signature)
      markers.push({
        recordIndex: record.index,
        componentKey: component.key,
        event,
        captureId: record.captureId,
        captureIndex: captureIndexes.get(record.captureId) ?? 0,
        calibratedTime: record.calibratedTime,
      })
    }
  }

  return markers
}

/** Groups sampled facts by collection pass without treating the pass as an atomic distributed moment. */
export const deriveTraceCaptures = (trace: ReadonlyArray<ScenarioTraceRecord>): ReadonlyArray<TraceCapture> => {
  const captures = new Map<string, number[]>()
  for (const record of trace) {
    if (record.captureId === null) continue
    const indexes = captures.get(record.captureId) ?? []
    indexes.push(record.index)
    captures.set(record.captureId, indexes)
  }
  return [...captures.entries()].map(([captureId, recordIndexes], captureIndex) => ({
    captureId,
    captureIndex,
    firstRecordIndex: recordIndexes[0]!,
    lastRecordIndex: recordIndexes.at(-1)!,
    recordIndexes,
  }))
}

/**
 * Derives disconnected intervals from acknowledged transitions, falling back to
 * sampled connectivity only when the trace did not retain an explicit boundary.
 */
export const deriveConnectivityIntervals = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<ConnectivityInterval> => {
  type OpenInterval = Omit<ConnectivityInterval, 'endRecordIndex' | 'endEvidence'>
  const openByClient = new Map<string, OpenInterval>()
  const intervals: ConnectivityInterval[] = []

  const open = (record: ScenarioTraceRecord, evidence: ConnectivityBoundaryEvidence): void => {
    if (record.clientId === null || openByClient.has(record.clientId) === true) return
    openByClient.set(record.clientId, {
      clientId: record.clientId,
      startRecordIndex: record.index,
      startEvidence: evidence,
    })
  }
  const close = (record: ScenarioTraceRecord, evidence: ConnectivityBoundaryEvidence): void => {
    if (record.clientId === null) return
    const interval = openByClient.get(record.clientId)
    if (interval === undefined) return
    intervals.push({ ...interval, endRecordIndex: record.index, endEvidence: evidence })
    openByClient.delete(record.clientId)
  }

  for (const record of trace) {
    switch (record.payload._tag) {
      case 'connectivity.disconnected':
        open(record, 'explicit-transition')
        break
      case 'connectivity.reconnected':
        close(record, 'explicit-transition')
        break
      case 'client.connectivity.observed':
        if (record.payload.connected === false) open(record, 'first-observed')
        else close(record, 'first-observed')
        break
      default:
        break
    }
  }

  intervals.push(
    ...[...openByClient.values()].map((interval) => ({
      ...interval,
      endRecordIndex: null,
      endEvidence: null,
    })),
  )
  return intervals.toSorted((left, right) => left.startRecordIndex - right.startRecordIndex)
}

/** Projects acknowledged creation and session lifecycle boundaries onto stable topology lanes. */
export const deriveLaneActivityIntervals = (args: {
  scenario: ScenarioAst
  trace: ReadonlyArray<ScenarioTraceRecord>
}): ReadonlyArray<LaneActivityInterval> => {
  const intervals: LaneActivityInterval[] = []
  const openByComponent = new Map<string, number>()
  const clientsById = new Map(args.scenario.topology.clients.map((client) => [client.id, client]))

  const open = (componentKey: string, recordIndex: number): void => {
    if (openByComponent.has(componentKey) === false) openByComponent.set(componentKey, recordIndex)
  }
  const close = (componentKey: string, recordIndex: number): void => {
    const startRecordIndex = openByComponent.get(componentKey)
    if (startRecordIndex === undefined) return
    intervals.push({ componentKey, startRecordIndex, endRecordIndex: recordIndex })
    openByComponent.delete(componentKey)
  }

  for (const record of args.trace) {
    switch (record.payload._tag) {
      case 'backend.observed':
        open(backendComponentKey, record.index)
        break
      case 'client.created': {
        if (record.clientId === null) break
        const client = clientsById.get(record.clientId)
        if (client === undefined) break
        open(leaderComponentKey(client.id), record.index)
        for (const sessionId of client.sessions) open(sessionComponentKey(client.id, sessionId), record.index)
        break
      }
      case 'lifecycle.session-stopped':
        if (record.clientId !== null && record.sessionId !== null) {
          close(sessionComponentKey(record.clientId, record.sessionId), record.index)
        }
        break
      case 'lifecycle.session-restarted':
        if (record.clientId !== null && record.sessionId !== null) {
          open(sessionComponentKey(record.clientId, record.sessionId), record.index)
        }
        break
      default:
        break
    }
  }

  intervals.push(
    ...[...openByComponent.entries()].map(([componentKey, startRecordIndex]) => ({
      componentKey,
      startRecordIndex,
      endRecordIndex: null,
    })),
  )
  return intervals.toSorted((left, right) => left.startRecordIndex - right.startRecordIndex)
}

/** Groups repeated runtime errors into participant-scoped unhealthy intervals. */
export const deriveRuntimeFailureIntervals = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<RuntimeFailureInterval> => {
  type OpenFailure = Omit<RuntimeFailureInterval, 'endRecordIndex'>
  const intervals: RuntimeFailureInterval[] = []
  const openByComponent = new Map<string, OpenFailure>()

  const close = (componentKey: string, endRecordIndex: number): void => {
    const interval = openByComponent.get(componentKey)
    if (interval === undefined) return
    intervals.push({ ...interval, endRecordIndex })
    openByComponent.delete(componentKey)
  }

  for (const record of trace) {
    switch (record.payload._tag) {
      case 'runtime.failure.observed': {
        if (record.clientId === null) break
        const componentKey =
          record.sessionId === null
            ? leaderComponentKey(record.clientId)
            : sessionComponentKey(record.clientId, record.sessionId)
        const open = openByComponent.get(componentKey)
        if (open === undefined) {
          openByComponent.set(componentKey, {
            componentKey,
            clientId: record.clientId,
            sessionId: record.sessionId,
            startRecordIndex: record.index,
            recordIndexes: [record.index],
            summary: summarizeFailureMessage(record.payload.message),
          })
        } else {
          openByComponent.set(componentKey, { ...open, recordIndexes: [...open.recordIndexes, record.index] })
        }
        break
      }
      case 'lifecycle.session-restarted':
        if (record.clientId !== null && record.sessionId !== null) {
          close(sessionComponentKey(record.clientId, record.sessionId), record.index)
        }
        break
      case 'lifecycle.client-restarted':
        if (record.clientId !== null) {
          close(leaderComponentKey(record.clientId), record.index)
          for (const componentKey of openByComponent.keys()) {
            if (componentKey.startsWith(`session:${record.clientId}/`) === true) close(componentKey, record.index)
          }
        }
        break
      default:
        break
    }
  }

  intervals.push(...[...openByComponent.values()].map((interval) => ({ ...interval, endRecordIndex: null })))
  return intervals.toSorted((left, right) => left.startRecordIndex - right.startRecordIndex)
}

/** Returns only causal relationships explicitly retained by the trace protocol. */
export const deriveExplicitCausalEdges = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<ExplicitCausalEdge> => {
  const recordIndexes = new Set(trace.map((record) => record.index))
  return trace.flatMap((record) =>
    record.causedBy
      .filter((cause) => recordIndexes.has(cause))
      .map((cause) => ({ fromRecordIndex: cause, toRecordIndex: record.index })),
  )
}

/**
 * Projects runner instructions and their retained outcomes without claiming a
 * complete concurrent history or inventing boundaries absent from the trace.
 */
export const deriveScenarioOperationHistory = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<ScenarioOperationHistoryEntry> => {
  const outcomes = new Map<
    string,
    { readonly recordIndex: number; readonly status: ScenarioOperationHistoryEntry['status'] }
  >()
  for (const record of trace) {
    if (record.correlationId === null) continue
    if (record.origin === 'acknowledgement') {
      outcomes.set(record.correlationId, { recordIndex: record.index, status: 'succeeded' })
    } else if (record.payload._tag === 'operation.outcome') {
      outcomes.set(record.correlationId, { recordIndex: record.index, status: record.payload.status })
    }
  }

  return trace.flatMap((record) => {
    if (record.origin !== 'instruction' || record.correlationId === null) return []
    const outcome = outcomes.get(record.correlationId)
    return [
      {
        operationId: record.correlationId,
        invocationRecordIndex: record.index,
        outcomeRecordIndex: outcome?.recordIndex ?? null,
        status: outcome?.status ?? 'pending',
      },
    ]
  })
}

/**
 * Preserves short elapsed-time distances while capping the visual width of long gaps.
 * Every distortion remains available as an explicit gap annotation.
 */
export const deriveAdaptiveTimeLayout = (
  timesMs: ReadonlyArray<number>,
  options?: { readonly compressionThresholdMs?: number; readonly compressedGapWidthMs?: number },
): AdaptiveTimeLayout => {
  const compressionThresholdMs = options?.compressionThresholdMs ?? 500
  const compressedGapWidthMs = options?.compressedGapWidthMs ?? 40
  const times = [...new Set(timesMs)].toSorted((left, right) => left - right)
  if (times.length === 0) return { points: [], compressedGaps: [] }
  if (times.length === 1) return { points: [{ timeMs: times[0]!, position: 0 }], compressedGaps: [] }

  const displayOffsets = [0]
  const compressedIndexes = new Set<number>()
  for (let index = 1; index < times.length; index += 1) {
    const durationMs = times[index]! - times[index - 1]!
    const compressed = durationMs > compressionThresholdMs
    if (compressed === true) compressedIndexes.add(index)
    displayOffsets.push(displayOffsets[index - 1]! + (compressed === true ? compressedGapWidthMs : durationMs))
  }
  const displayDuration = displayOffsets.at(-1) ?? 1
  const points = times.map((timeMs, index) => ({
    timeMs,
    position: displayDuration === 0 ? 0 : displayOffsets[index]! / displayDuration,
  }))
  const compressedGaps = [...compressedIndexes].map((index) => ({
    startMs: times[index - 1]!,
    endMs: times[index]!,
    durationMs: times[index]! - times[index - 1]!,
    startPosition: points[index - 1]!.position,
    endPosition: points[index]!.position,
  }))
  return { points, compressedGaps }
}

/** Maps any timestamp through an adaptive layout, including uncertainty-interval endpoints. */
export const projectAdaptiveTime = (layout: AdaptiveTimeLayout, timeMs: number): number => {
  if (layout.points.length === 0) return 0
  const first = layout.points[0]!
  if (timeMs <= first.timeMs) return first.position
  const last = layout.points.at(-1)!
  if (timeMs >= last.timeMs) return last.position

  for (let index = 1; index < layout.points.length; index += 1) {
    const right = layout.points[index]!
    if (timeMs > right.timeMs) continue
    const left = layout.points[index - 1]!
    const ratio = (timeMs - left.timeMs) / (right.timeMs - left.timeMs)
    return left.position + ratio * (right.position - left.position)
  }
  return last.position
}

export const backendComponentKey = 'backend'
export const leaderComponentKey = (clientId: string): string => `leader:${clientId}`
export const sessionComponentKey = (clientId: string, sessionId: string): string => `session:${clientId}/${sessionId}`

const initialObservedSystemState = (scenario: ScenarioAst, cursorIndex: number): ObservedSystemState => ({
  cursorIndex,
  runStatus: 'not-started',
  activePhaseId: null,
  backend: null,
  clients: scenario.topology.clients.map((client) => ({
    clientId: client.id,
    lifecycle: 'declared',
    health: 'unknown',
    connected: null,
    leader: null,
    sessions: client.sessions.map((sessionId) => ({
      sessionId,
      lifecycle: 'declared',
      health: 'unknown',
      sync: null,
    })),
  })),
  verdicts: [],
})

const applyTraceRecord = (state: ObservedSystemState, record: ScenarioTraceRecord): ObservedSystemState => {
  const payload = record.payload
  switch (payload._tag) {
    case 'run.started':
      return { ...state, runStatus: 'running' }
    case 'run.failed':
      return { ...state, runStatus: 'failed' }
    case 'run.completed':
      return { ...state, runStatus: payload.status }
    case 'phase.started':
      return { ...state, activePhaseId: record.phaseId }
    case 'phase.completed':
      return { ...state, activePhaseId: null }
    case 'client.created':
      return record.clientId === null
        ? state
        : updateClient(state, record.clientId, (client) => ({
            ...client,
            lifecycle: 'created',
            health: 'healthy',
            sessions: client.sessions.map((session) => ({ ...session, lifecycle: 'created', health: 'healthy' })),
          }))
    case 'lifecycle.session-stopped':
      return record.clientId === null || record.sessionId === null
        ? state
        : updateClient(state, record.clientId, (client) => {
            const sessions = client.sessions.map((session) =>
              session.sessionId === record.sessionId
                ? {
                    ...session,
                    lifecycle: 'stopped' as const,
                    health: session.health === 'failed' ? ('failed' as const) : ('unknown' as const),
                  }
                : session,
            )
            return { ...client, health: deriveClientHealth(client, sessions), sessions }
          })
    case 'lifecycle.session-restarted':
      return record.clientId === null || record.sessionId === null
        ? state
        : updateClient(state, record.clientId, (client) => {
            const sessions = client.sessions.map((session) =>
              session.sessionId === record.sessionId
                ? { ...session, lifecycle: 'created' as const, health: 'healthy' as const }
                : session,
            )
            return { ...client, health: deriveClientHealth(client, sessions), sessions }
          })
    case 'lifecycle.client-restarted':
      return record.clientId === null
        ? state
        : updateClient(state, record.clientId, (client) => ({
            ...client,
            lifecycle: 'created',
            health: 'healthy',
            sessions: client.sessions.map((session) => ({
              ...session,
              lifecycle: 'created',
              health: 'healthy',
            })),
          }))
    case 'runtime.failure.observed':
      return record.clientId === null
        ? state
        : updateClient(state, record.clientId, (client) => {
            if (record.sessionId === null) return { ...client, health: 'failed' }
            const sessions = client.sessions.map((session) =>
              session.sessionId === record.sessionId ? { ...session, health: 'failed' as const } : session,
            )
            return { ...client, health: 'degraded', sessions }
          })
    case 'backend.observed':
      return { ...state, backend: payload.observation }
    case 'client.connectivity.observed':
      return record.clientId === null
        ? state
        : updateClient(state, record.clientId, (client) => ({ ...client, connected: payload.connected }))
    case 'leader.sync.observed':
      return record.clientId === null
        ? state
        : updateClient(state, record.clientId, (client) => ({ ...client, leader: payload.observation }))
    case 'session.sync.observed':
      return record.clientId === null || record.sessionId === null
        ? state
        : updateClient(state, record.clientId, (client) => ({
            ...client,
            sessions: client.sessions.map((session) =>
              session.sessionId === record.sessionId ? { ...session, sync: payload.observation } : session,
            ),
          }))
    case 'oracle.verdict':
      return {
        ...state,
        verdicts: [
          ...state.verdicts.filter((verdict) => verdict.oracleId !== payload.oracleId),
          {
            oracleId: payload.oracleId,
            oracle: payload.oracle,
            status: payload.status,
            summary: payload.summary,
            evidence: payload.evidence,
          },
        ],
      }
    default:
      return state
  }
}

/** Excludes runner lifecycle and verdict bookkeeping from material system-state comparison. */
const materialSystemSignature = (state: ObservedSystemState): string =>
  JSON.stringify({ backend: state.backend, clients: state.clients })

const semanticMomentKind = (record: ScenarioTraceRecord): PlaybackMomentKind | undefined => {
  switch (record.payload._tag) {
    case 'run.started':
    case 'run.completed':
      return 'run'
    case 'run.failed':
    case 'operation.outcome':
    case 'settlement.failed':
    case 'runtime.failure.observed':
      return 'failure'
    case 'action.requested':
      return 'action'
    case 'client.created':
      return 'topology'
    case 'connectivity.disconnected':
    case 'connectivity.reconnected':
      return 'connectivity'
    case 'lifecycle.session-stopped':
    case 'lifecycle.session-restarted':
    case 'lifecycle.client-restarted':
      return 'lifecycle'
    case 'settlement.completed':
      return 'settlement'
    case 'oracle.verdict':
      return record.payload.status === 'failed' ? 'failure' : undefined
    default:
      return undefined
  }
}

/** Explains a semantic boundary without requiring the viewer to decode its payload shape. */
export const summarizeTraceRecord = (record: ScenarioTraceRecord): string => {
  const scope = [record.clientId, record.sessionId].filter((value) => value !== null).join('/')
  const scoped = (description: string): string => (scope.length === 0 ? description : `${scope}: ${description}`)

  switch (record.payload._tag) {
    case 'run.started':
      return 'Run started'
    case 'run.completed':
      return `Run completed: ${record.payload.status}`
    case 'run.failed':
      return `Run failed: ${summarizeFailureMessage(record.payload.message)}`
    case 'operation.outcome':
      return `Operation ${record.correlationId ?? 'unknown'} ${record.payload.status}: ${summarizeFailureMessage(record.payload.message)}`
    case 'phase.started':
      return `Phase ${record.phaseId ?? 'unknown'} started: ${record.payload.description}`
    case 'phase.completed':
      return `Phase ${record.phaseId ?? 'unknown'} completed`
    case 'client.create.requested':
      return scoped(`create requested with ${record.payload.sessions.length} sessions`)
    case 'action.requested':
      return scoped(`requested ${record.payload.action}`)
    case 'action.completed':
      return scoped(`${record.payload.action} control acknowledged`)
    case 'client.created':
      return scoped('created')
    case 'connectivity.disconnect.requested':
      return scoped('disconnect requested')
    case 'connectivity.reconnect.requested':
      return scoped('reconnect requested')
    case 'connectivity.disconnected':
      return scoped('disconnected')
    case 'connectivity.reconnected':
      return scoped('reconnected')
    case 'lifecycle.session-stop.requested':
      return scoped('session stop requested')
    case 'lifecycle.session-stopped':
      return scoped('stopped')
    case 'lifecycle.session-restart.requested':
      return scoped('session restart requested')
    case 'lifecycle.session-restarted':
      return scoped('restarted')
    case 'lifecycle.client-restart.requested':
      return scoped('Client restart requested')
    case 'lifecycle.client-restarted':
      return scoped('restarted')
    case 'settlement.requested':
      return `Settlement requested for ${record.payload.participants.length} participants`
    case 'settlement.progress':
      return `Settlement ${record.payload.settled === true ? 'reached' : 'pending'} · ${record.payload.observations.length} observations`
    case 'settlement.completed':
      return 'Settlement completed'
    case 'settlement.failed':
      return `Settlement failed: ${summarizeFailureMessage(record.payload.message)}`
    case 'runtime.failure.observed':
      return scoped(`runtime failure: ${summarizeFailureMessage(record.payload.message)}`)
    case 'sync.snapshot':
      return `${record.payload.participant}: local ${record.payload.localHead} · upstream ${record.payload.upstreamHead} · ${record.payload.pendingCount} pending`
    case 'state.snapshot':
      return scoped(`captured ${record.payload.inspector} state`)
    case 'backend.observed':
      return `Backend observed at ${record.payload.observation.head} · ${record.payload.observation.events.length} events`
    case 'client.connectivity.observed':
      return scoped(`observed ${record.payload.connected === true ? 'online' : 'offline'}`)
    case 'leader.sync.observed':
      return scoped(
        `Leader local ${record.payload.observation.localHead} · upstream ${record.payload.observation.upstreamHead} · ${record.payload.observation.pendingCount} pending`,
      )
    case 'session.sync.observed':
      return scoped(
        `session local ${record.payload.observation.localHead} · upstream ${record.payload.observation.upstreamHead} · ${record.payload.observation.pendingCount} pending`,
      )
    case 'oracle.verdict':
      return `Oracle ${record.payload.oracleId} ${record.payload.status}: ${record.payload.summary}`
  }
}

/** Summarizes only facts that changed across a material observation capture. */
const summarizeMaterialSystemChange = (before: ObservedSystemState, after: ObservedSystemState): string => {
  const changes: string[] = []
  const backendChange = describeBackendChange(before.backend, after.backend)
  if (backendChange !== undefined) changes.push(backendChange)

  const beforeClients = new Map(before.clients.map((client) => [client.clientId, client]))
  for (const client of after.clients) {
    const previous = beforeClients.get(client.clientId)
    if (previous === undefined) {
      changes.push(`${client.clientId} appeared`)
      continue
    }
    if (previous.lifecycle !== client.lifecycle) {
      changes.push(`${client.clientId} lifecycle ${previous.lifecycle} → ${client.lifecycle}`)
    }
    if (previous.health !== client.health) {
      changes.push(`${client.clientId} health ${previous.health} → ${client.health}`)
    }
    if (previous.connected !== client.connected) {
      changes.push(
        previous.connected === null
          ? `${client.clientId} first observed ${connectivityLabel(client.connected)}`
          : `${client.clientId} observed ${connectivityLabel(previous.connected)} → ${connectivityLabel(client.connected)}`,
      )
    }
    const leaderChange = describeSyncChange(`${client.clientId} Leader`, previous.leader, client.leader)
    if (leaderChange !== undefined) changes.push(leaderChange)

    const beforeSessions = new Map(previous.sessions.map((session) => [session.sessionId, session]))
    for (const session of client.sessions) {
      const previousSession = beforeSessions.get(session.sessionId)
      if (previousSession === undefined) {
        changes.push(`${client.clientId}/${session.sessionId} appeared`)
        continue
      }
      if (previousSession.lifecycle !== session.lifecycle) {
        changes.push(
          `${client.clientId}/${session.sessionId} lifecycle ${previousSession.lifecycle} → ${session.lifecycle}`,
        )
      }
      if (previousSession.health !== session.health) {
        changes.push(`${client.clientId}/${session.sessionId} health ${previousSession.health} → ${session.health}`)
      }
      const sessionChange = describeSyncChange(session.sessionId, previousSession.sync, session.sync)
      if (sessionChange !== undefined) changes.push(sessionChange)
    }
  }

  return changes.length === 0 ? 'Observed system state changed' : changes.join(' · ')
}

const describeBackendChange = (
  before: BackendObservation | null,
  after: BackendObservation | null,
): string | undefined => {
  if (before === null && after === null) return undefined
  if (before === null && after !== null) {
    return `Backend first observed ${connectivityLabel(after.connected)} at ${after.head}`
  }
  if (before !== null && after === null) return 'Backend observation became unavailable'
  if (before === null || after === null) return undefined

  const changes: string[] = []
  if (before.connected !== after.connected) {
    changes.push(`${connectivityLabel(before.connected)} → ${connectivityLabel(after.connected)}`)
  }
  if (before.head !== after.head) changes.push(`head ${before.head} → ${after.head}`)
  changes.push(...describeEventChanges(before.events, after.events))
  return changes.length === 0 ? undefined : `Backend: ${changes.join(', ')}`
}

const describeSyncChange = (
  label: string,
  before: ComponentSyncObservation | null,
  after: ComponentSyncObservation | null,
): string | undefined => {
  if (before === null && after === null) return undefined
  if (before === null && after !== null) {
    return `${label} first observed: local ${after.localHead}, upstream ${after.upstreamHead}, ${after.pendingCount} pending`
  }
  if (before !== null && after === null) return `${label} observation became unavailable`
  if (before === null || after === null) return undefined

  const changes: string[] = []
  if (before.localHead !== after.localHead) changes.push(`local ${before.localHead} → ${after.localHead}`)
  if (before.upstreamHead !== after.upstreamHead)
    changes.push(`upstream ${before.upstreamHead} → ${after.upstreamHead}`)
  if (before.pendingCount !== after.pendingCount) changes.push(`pending ${before.pendingCount} → ${after.pendingCount}`)
  changes.push(...describeEventChanges(before.events, after.events))
  return changes.length === 0 ? undefined : `${label}: ${changes.join(', ')}`
}

const describeEventChanges = (
  before: ReadonlyArray<ObservedEvent>,
  after: ReadonlyArray<ObservedEvent>,
): ReadonlyArray<string> => {
  const beforeByRef = new Map(before.map((event) => [event.eventRef, event]))
  const afterByRef = new Map(after.map((event) => [event.eventRef, event]))
  const added = after.filter((event) => beforeByRef.has(event.eventRef) === false).map((event) => event.position)
  const removed = before.filter((event) => afterByRef.has(event.eventRef) === false).map((event) => event.position)
  const changed = after.flatMap((event) => {
    const previous = beforeByRef.get(event.eventRef)
    if (previous === undefined || JSON.stringify(previous) === JSON.stringify(event)) return []
    return [
      previous.position === event.position ? `${event.position} updated` : `${previous.position} → ${event.position}`,
    ]
  })
  return [
    ...(added.length === 0 ? [] : [`events +${added.join(', ')}`]),
    ...(removed.length === 0 ? [] : [`events −${removed.join(', ')}`]),
    ...changed,
  ]
}

const connectivityLabel = (connected: boolean | null): string =>
  connected === null ? 'unknown' : connected === true ? 'online' : 'offline'

const summarizeFailureMessage = (message: string): string => {
  const constraintFailure = message.match(/(?:UNIQUE|NOT NULL|FOREIGN KEY|CHECK) constraint failed:[^)\]\n]+/u)?.[0]
  if (constraintFailure !== undefined) return constraintFailure.trim()
  const firstLine = message.split('\n', 1)[0]?.trim() ?? message.trim()
  return firstLine.length <= 180 ? firstLine : `${firstLine.slice(0, 179)}…`
}

const deriveClientHealth = (
  client: ProjectedClient,
  sessions: ReadonlyArray<ProjectedSession>,
): ProjectedClient['health'] => {
  if (client.health === 'failed') return 'failed'
  if (sessions.some((session) => session.health === 'failed') === true) return 'degraded'
  return client.lifecycle === 'declared' ? 'unknown' : 'healthy'
}

const updateClient = (
  state: ObservedSystemState,
  clientId: string,
  update: (client: ProjectedClient) => ProjectedClient,
): ObservedSystemState => ({
  ...state,
  clients: state.clients.map((client) => (client.clientId === clientId ? update(client) : client)),
})

const observationComponent = (
  record: ScenarioTraceRecord,
): { readonly key: string; readonly events: ReadonlyArray<ObservedEvent> } | undefined => {
  switch (record.payload._tag) {
    case 'backend.observed':
      return { key: backendComponentKey, events: record.payload.observation.events }
    case 'leader.sync.observed':
      return record.clientId === null
        ? undefined
        : { key: leaderComponentKey(record.clientId), events: record.payload.observation.events }
    case 'session.sync.observed':
      return record.clientId === null || record.sessionId === null
        ? undefined
        : {
            key: sessionComponentKey(record.clientId, record.sessionId),
            events: record.payload.observation.events,
          }
    default:
      return undefined
  }
}
