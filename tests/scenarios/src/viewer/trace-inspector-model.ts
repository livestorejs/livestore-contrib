import type { ComponentSyncObservation, ScenarioTraceRecord } from '../model.ts'

export interface RecordFact {
  readonly label: string
  readonly value: string
  readonly tone?: 'good' | 'warn' | 'bad'
}

export const traceRecordFacts = (record: ScenarioTraceRecord): ReadonlyArray<RecordFact> => {
  const payload = record.payload
  switch (payload._tag) {
    case 'run.started':
      return [
        { label: 'Scenario', value: payload.scenarioId },
        { label: 'Application', value: payload.applicationId },
        { label: 'Seed', value: String(payload.seed) },
      ]
    case 'run.completed':
      return [{ label: 'Status', value: payload.status, tone: payload.status === 'passed' ? 'good' : 'bad' }]
    case 'run.failed':
      return [
        { label: 'Code', value: payload.code, tone: 'bad' },
        { label: 'Step', value: payload.stepId ?? 'unknown' },
        { label: 'Message', value: conciseText(payload.message), tone: 'bad' },
      ]
    case 'operation.outcome':
      return [
        { label: 'Outcome', value: payload.status, tone: 'bad' },
        { label: 'Failure category', value: payload.code, tone: 'bad' },
        { label: 'Boundary', value: payload.status === 'indefinite' ? 'completion not observed' : 'failure reported' },
        { label: 'Message', value: conciseText(payload.message), tone: 'bad' },
      ]
    case 'phase.started':
      return [{ label: 'Description', value: payload.description }]
    case 'client.create.requested':
      return [
        { label: 'Sessions', value: payload.sessions.join(', ') || 'none' },
        { label: 'Initially connected', value: String(payload.initiallyConnected) },
      ]
    case 'client.created':
      return [{ label: 'Status', value: payload.status, tone: 'good' }]
    case 'action.completed':
      return [
        { label: 'Action', value: payload.action },
        { label: 'Status', value: payload.status, tone: 'good' },
      ]
    case 'action.requested':
      return [
        { label: 'Action', value: payload.action },
        { label: 'Input', value: jsonValueSummary(payload.input) },
      ]
    case 'action-sequence.requested':
      return [
        { label: 'Action sequence', value: payload.description },
        { label: 'Count', value: String(payload.count) },
        { label: 'Derived seed', value: String(payload.seed) },
        { label: 'Targets', value: payload.targets.join(', ') },
      ]
    case 'action-sequence.completed':
      return [
        { label: 'Actions', value: String(payload.actionIds.length), tone: 'good' },
        { label: 'Status', value: payload.status, tone: 'good' },
      ]
    case 'connectivity.disconnect.requested':
    case 'connectivity.reconnect.requested':
    case 'connectivity.disconnected':
    case 'connectivity.reconnected':
      return [
        { label: 'Connected', value: String(payload.connected), tone: payload.connected === true ? 'good' : 'warn' },
      ]
    case 'backend.availability.requested':
    case 'backend.availability.changed':
      return [
        {
          label: 'Backend available',
          value: String(payload.available),
          tone: payload.available === true ? 'good' : 'warn',
        },
      ]
    case 'fault.injected':
    case 'fault.removed':
      return [
        { label: 'Fault', value: payload.fault },
        { label: 'Fault ID', value: payload.faultId },
        { label: 'Boundary', value: payload._tag === 'fault.injected' ? 'injected' : 'removed' },
      ]
    case 'quiescence.reached':
      return [
        { label: 'Quiescent', value: 'true', tone: 'good' },
        { label: 'In-flight modifying operations', value: payload.inFlightOperationIds.join(', ') || 'none' },
      ]
    case 'recovery.observed':
      return [
        { label: 'Faults', value: payload.faultIds.join(', ') },
        {
          label: 'Convergence predicate',
          value: String(payload.converged),
          tone: payload.converged === true ? 'good' : 'warn',
        },
        { label: 'Observations', value: `${payload.observations.length} participants` },
      ]
    case 'recovery.completed':
      return [
        { label: 'Faults', value: payload.faultIds.join(', '), tone: 'good' },
        { label: 'Observations', value: `${payload.observations.length} recovered participants`, tone: 'good' },
      ]
    case 'settlement.requested':
      return [
        { label: 'Participants', value: payload.participants.join(', ') },
        { label: 'Fault removal', value: payload.healDisconnectedClients.join(', ') || 'none' },
        { label: 'Timeout', value: `${payload.timeoutMs} ms` },
      ]
    case 'settlement.progress':
      return [
        {
          label: 'Convergence predicate',
          value: String(payload.settled),
          tone: payload.settled === true ? 'good' : 'warn',
        },
        { label: 'Observations', value: `${payload.observations.length} participants` },
      ]
    case 'settlement.completed':
      return [{ label: 'Observations', value: `${payload.observations.length} converged participants`, tone: 'good' }]
    case 'settlement.failed':
      return [
        { label: 'Code', value: payload.code, tone: 'bad' },
        { label: 'Timeout', value: `${payload.timeoutMs} ms` },
        { label: 'Observations', value: `${payload.observations.length} participants` },
        { label: 'Message', value: conciseText(payload.message), tone: 'bad' },
      ]
    case 'runtime.failure.observed':
      return [
        { label: 'Source', value: payload.source },
        { label: 'Code', value: payload.code, tone: 'bad' },
        { label: 'Message', value: conciseText(payload.message), tone: 'bad' },
      ]
    case 'sync.snapshot':
      return syncObservationFacts(payload)
    case 'state.snapshot':
      return [
        { label: 'Inspector', value: payload.inspector },
        { label: 'Value', value: jsonValueSummary(payload.value) },
      ]
    case 'backend.observed':
      return [
        { label: 'Reason', value: payload.reason },
        { label: 'Connected', value: String(payload.observation.connected) },
        { label: 'Head', value: payload.observation.head },
        { label: 'Events', value: `${payload.observation.events.length} observed` },
      ]
    case 'client.connectivity.observed':
      return [
        { label: 'Reason', value: payload.reason },
        { label: 'Connected', value: String(payload.connected), tone: payload.connected === true ? 'good' : 'warn' },
      ]
    case 'leader.sync.observed':
    case 'session.sync.observed':
      return [{ label: 'Reason', value: payload.reason }, ...componentObservationFacts(payload.observation)]
    case 'oracle.verdict':
      return [
        { label: 'Oracle', value: payload.oracle },
        { label: 'Status', value: payload.status, tone: payload.status === 'passed' ? 'good' : 'bad' },
        { label: 'Summary', value: payload.summary },
        { label: 'Evidence', value: `${payload.evidence.length} records` },
      ]
    default:
      return []
  }
}

export const detailRecordScope = (record: ScenarioTraceRecord): string => {
  if (record.payload._tag === 'backend.observed') return 'Backend'
  if (record.sessionId !== null) return record.sessionId
  if (record.clientId !== null && record.payload._tag === 'leader.sync.observed') return 'Leader'
  if (record.clientId !== null) return 'Client'
  return 'System'
}

export const groupDetailRecords = (
  records: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<{ readonly label: string; readonly records: ReadonlyArray<ScenarioTraceRecord> }> => {
  const groups = new Map<string, { label: string; records: ScenarioTraceRecord[] }>()
  for (const record of records) {
    const [key, label] =
      record.payload._tag === 'backend.observed'
        ? ['backend', 'Sync backend']
        : record.clientId !== null
          ? [`client:${record.clientId}`, record.clientId]
          : ['system', 'Scenario system']
    const group = groups.get(key) ?? { label, records: [] }
    group.records.push(record)
    groups.set(key, group)
  }
  return [...groups.values()]
}

const syncObservationFacts = (observation: {
  readonly participant: string
  readonly localHead: string
  readonly upstreamHead: string
  readonly pendingCount: number
  readonly isSynced: boolean
}): ReadonlyArray<RecordFact> => [
  { label: 'Participant', value: observation.participant },
  { label: 'Local head', value: observation.localHead },
  { label: 'Upstream head', value: observation.upstreamHead },
  { label: 'Pending', value: String(observation.pendingCount), tone: observation.pendingCount === 0 ? 'good' : 'warn' },
  {
    label: 'Synced',
    value: String(observation.isSynced),
    tone: observation.isSynced === true ? 'good' : 'warn',
  },
]

const componentObservationFacts = (observation: ComponentSyncObservation): ReadonlyArray<RecordFact> => [
  { label: 'Local head', value: observation.localHead },
  { label: 'Upstream head', value: observation.upstreamHead },
  { label: 'Pending', value: String(observation.pendingCount), tone: observation.pendingCount === 0 ? 'good' : 'warn' },
  { label: 'Events', value: `${observation.events.length} observed` },
]

const conciseText = (value: string): string => {
  const firstLine = value.split('\n', 1)[0]?.trim() ?? value.trim()
  return firstLine.length <= 220 ? firstLine : `${firstLine.slice(0, 219)}…`
}

const jsonValueSummary = (value: unknown): string => {
  if (Array.isArray(value) === true) return `Array(${value.length})`
  if (value !== null && typeof value === 'object') return `Object(${Object.keys(value).length})`
  if (typeof value === 'string') return conciseText(value)
  return String(value)
}
