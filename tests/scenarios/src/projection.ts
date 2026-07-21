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
  sync: Schema.NullOr(ComponentSyncObservation),
})
export type ProjectedSession = typeof ProjectedSession.Type

export const ProjectedClient = Schema.Struct({
  clientId: Schema.String,
  lifecycle: Schema.Literals(['declared', 'created']),
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
}

export interface ExplicitCausalEdge {
  readonly fromRecordIndex: number
  readonly toRecordIndex: number
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
      })
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
    })
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
    connected: null,
    leader: null,
    sessions: client.sessions.map((sessionId) => ({ sessionId, lifecycle: 'declared', sync: null })),
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
            sessions: client.sessions.map((session) => ({ ...session, lifecycle: 'created' })),
          }))
    case 'lifecycle.session-stopped':
      return record.clientId === null || record.sessionId === null
        ? state
        : updateClient(state, record.clientId, (client) => ({
            ...client,
            sessions: client.sessions.map((session) =>
              session.sessionId === record.sessionId ? { ...session, lifecycle: 'stopped' } : session,
            ),
          }))
    case 'lifecycle.session-restarted':
      return record.clientId === null || record.sessionId === null
        ? state
        : updateClient(state, record.clientId, (client) => ({
            ...client,
            sessions: client.sessions.map((session) =>
              session.sessionId === record.sessionId ? { ...session, lifecycle: 'created' } : session,
            ),
          }))
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
