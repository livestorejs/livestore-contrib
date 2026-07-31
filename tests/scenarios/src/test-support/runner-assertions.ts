import { expect } from 'vitest'

import { Effect } from '@livestore/utils/effect'

import type { HostSystemObservation, ObservedEvent, ScenarioRunArtifact } from '../model.ts'
import type { ParticipantHost } from '../profiles/contract.ts'

export type TransientPrefixMutation = 'conflict' | 'delete' | 'duplicate' | 'rewrite' | 'reorder'

/** Produces one bad retained sample, then resumes the host's unmodified complete observations. */
export const withTransientSessionEventlogMutation = (
  host: ParticipantHost,
  mutation: TransientPrefixMutation,
): ParticipantHost => {
  let eligibleObservations = 0
  let injected = false
  return {
    ...host,
    observeSystem: host.observeSystem.pipe(
      Effect.map((observation) => {
        if (injected === true) return observation
        const target = observation.clients
          .find((client) => client.clientId === 'client-b')
          ?.sessions.find((session) => session.sessionId === 'session-b')
        const confirmedCount = target?.sync.events.filter((event) => event.disposition === 'confirmed').length ?? 0
        const requiredCount = mutation === 'reorder' ? 2 : 1
        if (confirmedCount < requiredCount) return observation
        eligibleObservations += 1
        if (eligibleObservations < 2) return observation
        injected = true
        return mutateSessionObservation(observation, mutation)
      }),
    ),
  }
}

const mutateSessionObservation = (
  observation: HostSystemObservation,
  mutation: TransientPrefixMutation,
): HostSystemObservation => ({
  ...observation,
  clients: observation.clients.map((client) =>
    client.clientId !== 'client-b'
      ? client
      : {
          ...client,
          sessions: client.sessions.map((session) =>
            session.sessionId !== 'session-b'
              ? session
              : {
                  ...session,
                  sync: {
                    ...session.sync,
                    events: mutateConfirmedEvents(session.sync.events, mutation),
                  },
                },
          ),
        },
  ),
})

const mutateConfirmedEvents = (
  events: ReadonlyArray<ObservedEvent>,
  mutation: TransientPrefixMutation,
): ReadonlyArray<ObservedEvent> => {
  const confirmedIndexes = events.flatMap((event, index) => (event.disposition === 'confirmed' ? [index] : []))
  const first = confirmedIndexes[0]!
  if (mutation === 'conflict') {
    return events.toSpliced(first, 0, { ...events[first]!, name: `${events[first]!.name}.conflicting` })
  }
  if (mutation === 'delete') return events.filter((_event, index) => index !== first)
  if (mutation === 'duplicate') return events.toSpliced(first, 0, events[first]!)
  if (mutation === 'rewrite') {
    return events.map((event, index) => (index === first ? { ...event, name: `${event.name}.rewritten` } : event))
  }
  const second = confirmedIndexes[1]!
  const reordered = [...events]
  ;[reordered[first], reordered[second]] = [reordered[second]!, reordered[first]!]
  return reordered
}

/** Ensures sampled correlation remains useful for one unambiguous pending-to-confirmed Event. */
export const expectOfflineEventCorrelationLifecycle = (artifact: ScenarioRunArtifact): void => {
  const reconnectIndex = artifact.trace.find(
    (record) => record.clientId === 'client-a' && record.payload._tag === 'connectivity.reconnected',
  )?.index
  expect(reconnectIndex).toBeDefined()
  const offlineObservation = artifact.trace.find(
    (record) =>
      reconnectIndex !== undefined &&
      record.index < reconnectIndex &&
      record.clientId === 'client-a' &&
      record.payload._tag === 'leader.sync.observed' &&
      record.payload.observation.events.some(
        (event) => event.origin.clientId === 'client-a' && event.disposition === 'pending',
      ),
  )
  expect(offlineObservation?.payload._tag).toBe('leader.sync.observed')
  if (offlineObservation?.payload._tag !== 'leader.sync.observed') return

  const pendingEvent = offlineObservation.payload.observation.events.find(
    (event) => event.origin.clientId === 'client-a' && event.disposition === 'pending',
  )
  expect(pendingEvent).toBeDefined()
  expect(offlineObservation.payload.observation.pendingCount).toBeGreaterThan(0)

  const recoveredObservation = artifact.trace.findLast(
    (record) =>
      record.clientId === 'client-a' &&
      record.payload._tag === 'leader.sync.observed' &&
      record.payload.reason === 'settle-after-reconnect',
  )
  expect(recoveredObservation?.payload._tag).toBe('leader.sync.observed')
  if (pendingEvent === undefined || recoveredObservation?.payload._tag !== 'leader.sync.observed') return

  expect(recoveredObservation.payload.observation.pendingCount).toBe(0)
  expect(recoveredObservation.payload.observation.events).toContainEqual(
    expect.objectContaining({ eventRef: pendingEvent.eventRef, disposition: 'confirmed' }),
  )
}

export const expectBackendOutageRecovery = (artifact: ScenarioRunArtifact): void => {
  expect(artifact.status).toBe('passed')
  const injected = artifact.trace.find(
    (record) => record.payload._tag === 'fault.injected' && record.payload.fault === 'backend-unavailable',
  )
  const removed = artifact.trace.find(
    (record) => record.payload._tag === 'fault.removed' && record.payload.fault === 'backend-unavailable',
  )
  const recovered = artifact.trace.find(
    (record) =>
      record.payload._tag === 'recovery.completed' && record.payload.faultIds.includes('backend-outage-started'),
  )
  expect(injected).toBeDefined()
  expect(removed?.index).toBeGreaterThan(injected?.index ?? Number.POSITIVE_INFINITY)
  expect(recovered?.index).toBeGreaterThan(removed?.index ?? Number.POSITIVE_INFINITY)
  const observedOutage = artifact.trace.find(
    (record) =>
      record.index > (injected?.index ?? Number.POSITIVE_INFINITY) &&
      record.index < (removed?.index ?? Number.NEGATIVE_INFINITY) &&
      record.payload._tag === 'backend.observed' &&
      record.payload.observation.connected === false,
  )
  const pendingDuringOutage = artifact.trace.find(
    (record) =>
      record.index > (injected?.index ?? Number.POSITIVE_INFINITY) &&
      record.index < (removed?.index ?? Number.NEGATIVE_INFINITY) &&
      record.payload._tag === 'leader.sync.observed' &&
      record.payload.observation.pendingCount > 0,
  )
  expect(observedOutage).toBeDefined()
  expect(pendingDuringOutage).toBeDefined()
  expect(artifact.snapshots.every((snapshot) => snapshot.sync.pendingCount === 0)).toBe(true)
  expect(artifact.verdicts.every((verdict) => verdict.status === 'passed')).toBe(true)
}

export const workloadActionSignature = (artifact: ScenarioRunArtifact): ReadonlyArray<unknown> =>
  artifact.trace.flatMap((record) =>
    record.payload._tag === 'action.requested' && record.causationId === 'create-seeded-todos'
      ? [
          {
            operationId: record.correlationId,
            participant: `${record.clientId}/${record.sessionId}`,
            action: record.payload.action,
            input: record.payload.input,
          },
        ]
      : [],
  )
