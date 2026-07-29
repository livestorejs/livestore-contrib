import type { ScenarioAst, ScenarioTraceRecord } from '../model.ts'
import {
  backendComponentKey,
  leaderComponentKey,
  scenarioClientCreationDefinitions,
  sessionComponentKey,
  summarizeFailureMessage,
} from './system-state.ts'
import type {
  ConnectivityBoundaryEvidence,
  ConnectivityInterval,
  LaneActivityInterval,
  RuntimeFailureInterval,
} from './types.ts'

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
  const clientsById = new Map(scenarioClientCreationDefinitions(args.scenario).map((client) => [client.id, client]))

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
      case 'lifecycle.session-added':
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
