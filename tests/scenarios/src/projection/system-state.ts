import {
  type BackendObservation,
  type ComponentSyncObservation,
  deriveScenarioTopology,
  type ObservedEvent,
  type ScenarioAst,
  type ScenarioTracePayload,
  type ScenarioTraceRecord,
} from '../model.ts'
import type {
  ObservedSystemState,
  PlaybackMomentKind,
  ProjectedClient,
  ProjectedSession,
  ScenarioOperationHistoryFamily,
} from './types.ts'

export const backendComponentKey = 'backend'
export const leaderComponentKey = (clientId: string): string => `leader:${clientId}`
export const sessionComponentKey = (clientId: string, sessionId: string): string => `session:${clientId}/${sessionId}`

/** Keeps Client creation sessions distinct from sessions attached by later plan steps. */
export const scenarioClientCreationDefinitions = (scenario: ScenarioAst) => [
  ...scenario.topology.clients,
  ...scenario.instructions.flatMap((instruction) => (instruction._tag === 'create-client' ? [instruction.client] : [])),
]

export const initialObservedSystemState = (scenario: ScenarioAst, cursorIndex: number): ObservedSystemState => ({
  cursorIndex,
  runStatus: 'not-started',
  backend: null,
  clients: deriveScenarioTopology(scenario).map((client) => ({
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

export const applyTraceRecord = (
  state: ObservedSystemState,
  record: ScenarioTraceRecord,
  scenario: ScenarioAst,
): ObservedSystemState => {
  const payload = record.payload
  switch (payload._tag) {
    case 'run.started':
      return { ...state, runStatus: 'running' }
    case 'run.failed':
      return { ...state, runStatus: 'failed' }
    case 'run.completed':
      return { ...state, runStatus: payload.status }
    case 'client.created':
      if (record.clientId === null) return state
      return updateClient(state, record.clientId, (client) => {
        const createdSessions = new Set(
          scenarioClientCreationDefinitions(scenario).find((definition) => definition.id === record.clientId)
            ?.sessions ?? [],
        )
        return {
          ...client,
          lifecycle: 'created',
          health: 'healthy',
          sessions: client.sessions.map((session) =>
            createdSessions.has(session.sessionId) === true
              ? { ...session, lifecycle: 'created' as const, health: 'healthy' as const }
              : session,
          ),
        }
      })
    case 'lifecycle.session-added':
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
            sessions: client.sessions.map((session) =>
              session.lifecycle === 'declared'
                ? session
                : { ...session, lifecycle: 'created' as const, health: 'healthy' as const },
            ),
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
export const materialSystemSignature = (state: ObservedSystemState): string =>
  JSON.stringify({ backend: state.backend, clients: state.clients })

export const semanticMomentKind = (record: ScenarioTraceRecord): PlaybackMomentKind | undefined => {
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
    case 'action-sequence.requested':
      return 'action'
    case 'annotation.reached':
      return 'annotation'
    case 'client.created':
      return 'topology'
    case 'connectivity.disconnected':
    case 'connectivity.reconnected':
    case 'backend.availability.changed':
    case 'fault.injected':
    case 'fault.removed':
      return 'connectivity'
    case 'lifecycle.session-stopped':
    case 'lifecycle.session-restarted':
    case 'lifecycle.session-added':
    case 'lifecycle.client-restarted':
      return 'lifecycle'
    case 'settlement.completed':
    case 'quiescence.reached':
    case 'recovery.completed':
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
    case 'annotation.reached':
      return record.payload.text
    case 'client.create.requested':
      return scoped(`create requested with ${record.payload.sessions.length} sessions`)
    case 'action.requested':
      return scoped(`requested ${record.payload.action}`)
    case 'action.completed':
      return scoped(`${record.payload.action} control acknowledged`)
    case 'action-sequence.requested':
      return `Requested action sequence ${record.payload.description} · ${record.payload.count} actions · seed ${record.payload.seed}`
    case 'action-sequence.completed':
      return `Action sequence completed · ${record.payload.actionIds.length} actions`
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
    case 'backend.availability.requested':
      return `Backend ${record.payload.available === true ? 'availability' : 'unavailability'} requested`
    case 'backend.availability.changed':
      return `Backend availability control acknowledged: ${record.payload.available === true ? 'available' : 'unavailable'}`
    case 'fault.injected':
      return scoped(`fault ${record.payload.faultId} injected`)
    case 'fault.removed':
      return scoped(`fault ${record.payload.faultId} removed`)
    case 'quiescence.reached':
      return `Quiescence reached · ${record.payload.inFlightOperationIds.length} modifying operations in flight`
    case 'recovery.observed':
      return `Recovery observed for ${record.payload.faultIds.length} faults · ${record.payload.converged === true ? 'convergence predicate reached' : 'progress pending'}`
    case 'recovery.completed':
      return `Recovery completed for ${record.payload.faultIds.length} faults`
    case 'lifecycle.session-stop.requested':
      return scoped('session stop requested')
    case 'lifecycle.session-stopped':
      return scoped('stopped')
    case 'lifecycle.session-restart.requested':
      return scoped('session restart requested')
    case 'lifecycle.session-restarted':
      return scoped('restarted')
    case 'lifecycle.session-add.requested':
      return scoped('session addition requested')
    case 'lifecycle.session-added':
      return scoped('added')
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
    case 'terminal-stabilization.requested':
      return `Terminal stabilization requested for ${record.payload.participants.length} participants`
    case 'terminal-stabilization.progress':
      return `Terminal stabilization ${record.payload.settled === true ? 'reached' : 'pending'} · ${record.payload.observations.length} observations`
    case 'terminal-stabilization.completed':
      return 'Terminal stabilization completed'
    case 'terminal-stabilization.failed':
      return `Terminal stabilization failed: ${summarizeFailureMessage(record.payload.message)}`
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
export const summarizeMaterialSystemChange = (before: ObservedSystemState, after: ObservedSystemState): string => {
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

export const summarizeFailureMessage = (message: string): string => {
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

export const observationComponent = (
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

export const operationFamily = (payload: ScenarioTracePayload): ScenarioOperationHistoryFamily | undefined => {
  switch (payload._tag) {
    case 'client.create.requested':
      return 'client-create'
    case 'action.requested':
      return 'application-action'
    case 'action-sequence.requested':
      return 'action-sequence'
    case 'connectivity.disconnect.requested':
    case 'connectivity.reconnect.requested':
      return 'connectivity'
    case 'backend.availability.requested':
      return 'backend-availability'
    case 'lifecycle.session-stop.requested':
    case 'lifecycle.session-restart.requested':
    case 'lifecycle.session-add.requested':
      return 'session-lifecycle'
    case 'lifecycle.client-restart.requested':
      return 'client-lifecycle'
    case 'settlement.requested':
      return 'settlement'
    default:
      return undefined
  }
}
