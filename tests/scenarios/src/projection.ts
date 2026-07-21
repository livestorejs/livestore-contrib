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

export interface ExplicitCausalEdge {
  readonly fromRecordIndex: number
  readonly toRecordIndex: number
}

/** Reduces the authoritative trace prefix into the runner's accumulated observed state. */
export const projectTraceAt = (args: {
  scenario: ScenarioAst
  trace: ReadonlyArray<ScenarioTraceRecord>
  cursorIndex: number
}): ObservedSystemState => {
  const cursorIndex = Math.min(Math.max(args.cursorIndex, -1), args.trace.length - 1)
  let state: ObservedSystemState = {
    cursorIndex,
    runStatus: 'not-started',
    activePhaseId: null,
    backend: null,
    clients: args.scenario.topology.clients.map((client) => ({
      clientId: client.id,
      lifecycle: 'declared',
      connected: null,
      leader: null,
      sessions: client.sessions.map((sessionId) => ({ sessionId, lifecycle: 'declared', sync: null })),
    })),
    verdicts: [],
  }

  for (const record of args.trace.slice(0, cursorIndex + 1)) {
    const payload = record.payload
    switch (payload._tag) {
      case 'run.started':
        state = { ...state, runStatus: 'running' }
        break
      case 'run.completed':
        state = { ...state, runStatus: payload.status }
        break
      case 'phase.started':
        state = { ...state, activePhaseId: record.phaseId }
        break
      case 'phase.completed':
        state = { ...state, activePhaseId: null }
        break
      case 'client.created':
        if (record.clientId !== null) {
          state = updateClient(state, record.clientId, (client) => ({
            ...client,
            lifecycle: 'created',
            sessions: client.sessions.map((session) => ({ ...session, lifecycle: 'created' })),
          }))
        }
        break
      case 'lifecycle.session-stopped':
        if (record.clientId !== null && record.sessionId !== null) {
          state = updateClient(state, record.clientId, (client) => ({
            ...client,
            sessions: client.sessions.map((session) =>
              session.sessionId === record.sessionId ? { ...session, lifecycle: 'stopped' } : session,
            ),
          }))
        }
        break
      case 'lifecycle.session-restarted':
        if (record.clientId !== null && record.sessionId !== null) {
          state = updateClient(state, record.clientId, (client) => ({
            ...client,
            sessions: client.sessions.map((session) =>
              session.sessionId === record.sessionId ? { ...session, lifecycle: 'created' } : session,
            ),
          }))
        }
        break
      case 'backend.observed':
        state = { ...state, backend: payload.observation }
        break
      case 'client.connectivity.observed':
        if (record.clientId !== null) {
          state = updateClient(state, record.clientId, (client) => ({ ...client, connected: payload.connected }))
        }
        break
      case 'leader.sync.observed':
        if (record.clientId !== null) {
          state = updateClient(state, record.clientId, (client) => ({ ...client, leader: payload.observation }))
        }
        break
      case 'session.sync.observed':
        if (record.clientId !== null && record.sessionId !== null) {
          state = updateClient(state, record.clientId, (client) => ({
            ...client,
            sessions: client.sessions.map((session) =>
              session.sessionId === record.sessionId ? { ...session, sync: payload.observation } : session,
            ),
          }))
        }
        break
      case 'oracle.verdict':
        state = {
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
        break
      default:
        break
    }
  }

  return Schema.decodeUnknownSync(ObservedSystemState)(state)
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

export const backendComponentKey = 'backend'
export const leaderComponentKey = (clientId: string): string => `leader:${clientId}`
export const sessionComponentKey = (clientId: string, sessionId: string): string => `session:${clientId}/${sessionId}`

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
