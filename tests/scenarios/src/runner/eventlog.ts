import { EventSequenceNumber } from '@livestore/common/schema'
import { Schema } from '@livestore/utils/effect'

import {
  type ObservedEvent,
  type OracleVerdict,
  type ParticipantRef,
  participantKey,
  type ScenarioOracle,
  type ScenarioTraceRecord,
  type SyncObservation,
  type SyncObservationPayload,
} from '../model.ts'
import { backendComponentKey, leaderComponentKey, sessionComponentKey } from '../projection.ts'
import type {
  CanonicalObservedEvent,
  EventlogCaptureAccumulator,
  EventlogCaptureEvidence,
  ParticipantEventlogEvidence,
} from './oracles.ts'

export const globalPosition = (head: string): number => EventSequenceNumber.Client.fromString(head).global

export const observedComponentEventlog = (
  record: ScenarioTraceRecord,
): { readonly key: string; readonly events: ReadonlyArray<ObservedEvent> } | undefined => {
  switch (record.payload._tag) {
    case 'backend.observed':
      return {
        key: backendComponentKey,
        events: record.payload.observation.events,
      }
    case 'leader.sync.observed':
      return record.clientId === null
        ? undefined
        : {
            key: leaderComponentKey(record.clientId),
            events: record.payload.observation.events,
          }
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

/** Selects one non-atomic capture only when it contains every fact the oracle compares. */
export const latestCompleteEventlogCapture = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
  participants: ReadonlyArray<ParticipantRef>,
): EventlogCaptureEvidence | undefined => {
  const participantKeys = new Set(participants.map(participantKey))
  const captures = new Map<string, EventlogCaptureAccumulator>()

  for (const record of trace) {
    if (record.captureId === null) continue
    const capture =
      captures.get(record.captureId) ??
      ({ participants: new Map<string, ParticipantEventlogEvidence>() } satisfies EventlogCaptureAccumulator)
    captures.set(record.captureId, capture)

    if (record.payload._tag === 'backend.observed') {
      capture.backend = {
        recordIndex: record.index,
        head: record.payload.observation.head,
        events: record.payload.observation.events,
      }
    } else if (
      record.payload._tag === 'session.sync.observed' &&
      record.clientId !== null &&
      record.sessionId !== null
    ) {
      const key = participantKey({ clientId: record.clientId, sessionId: record.sessionId })
      if (participantKeys.has(key) === true) {
        capture.participants.set(key, {
          recordIndex: record.index,
          observation: record.payload.observation,
        })
      }
    }
  }

  for (const capture of [...captures.values()].toReversed()) {
    if (
      capture.backend !== undefined &&
      participants.every((participant) => capture.participants.has(participantKey(participant))) === true
    ) {
      return { backend: capture.backend, participants: capture.participants }
    }
  }
  return undefined
}

export const firstEventlogMismatch = (
  expectedEvents: ReadonlyArray<ObservedEvent>,
  observedEvents: ReadonlyArray<ObservedEvent>,
):
  | {
      readonly position: string
      readonly expected: string
      readonly observed: string
    }
  | undefined => {
  const eventCount = Math.max(expectedEvents.length, observedEvents.length)
  for (let index = 0; index < eventCount; index += 1) {
    const expected = expectedEvents[index]
    const observed = observedEvents[index]
    if (expected === undefined || observed === undefined || eventFact(expected) !== eventFact(observed)) {
      return {
        position: expected?.position ?? observed?.position ?? `index ${index}`,
        expected: describeEventFact(expected),
        observed: describeEventFact(observed),
      }
    }
  }
  return undefined
}

export const firstEventlogPrefixMismatch = (
  previousEvents: ReadonlyArray<CanonicalObservedEvent>,
  observedEvents: ReadonlyArray<CanonicalObservedEvent>,
):
  | {
      readonly position: string
      readonly expected: string
      readonly observed: string
    }
  | undefined => {
  for (let index = 0; index < previousEvents.length; index += 1) {
    const expected = previousEvents[index]!
    const observed = observedEvents[index]
    if (observed === undefined || expected.fact !== observed.fact) {
      return {
        position: expected.position,
        expected: expected.description,
        observed: observed?.description ?? 'no Event',
      }
    }
  }
  return undefined
}

export const canonicalObservedEvent = (event: ObservedEvent): CanonicalObservedEvent => ({
  fact: eventFact(event),
  position: event.position,
  description: describeEventFact(event),
})

/** A concurrent paged pull may repeat one encoding; a global position cannot name two different Event facts. */
export const canonicalConfirmedEvents = (
  observedEvents: ReadonlyArray<ObservedEvent>,
):
  | {
      readonly _tag: 'events'
      readonly events: ReadonlyArray<CanonicalObservedEvent>
      readonly repeatedEncodingCount: number
    }
  | { readonly _tag: 'conflict'; readonly position: number } => {
  const events: CanonicalObservedEvent[] = []
  const factByPosition = new Map<number, string>()
  let repeatedEncodingCount = 0
  for (const event of observedEvents) {
    if (event.disposition !== 'confirmed') continue
    const canonical = canonicalObservedEvent(event)
    const position = globalPosition(event.position)
    const previous = factByPosition.get(position)
    if (previous === canonical.fact) {
      repeatedEncodingCount += 1
      continue
    }
    if (previous !== undefined) return { _tag: 'conflict', position }
    factByPosition.set(position, canonical.fact)
    events.push(canonical)
  }
  return { _tag: 'events', events, repeatedEncodingCount }
}

/** Eventlog equality uses portable Event facts; inferred eventRef correlation is non-authoritative. */
const eventFact = (event: ObservedEvent): string =>
  canonicalJson({
    name: event.name,
    args: event.args,
    origin: event.origin,
    position: globalPosition(event.position),
    parentPosition: globalPosition(event.parentPosition),
  })!

const describeEventFact = (event: ObservedEvent | undefined): string =>
  event === undefined ? 'no Event' : `${event.name} from ${participantKey(event.origin)} at ${event.position}`

export const syncObservationPayload = (observation: SyncObservation): SyncObservationPayload => ({
  participant: participantKey(observation.participant),
  localHead: observation.localHead,
  upstreamHead: observation.upstreamHead,
  pendingCount: observation.pendingCount,
  isSynced: observation.isSynced,
})

export const canonicalJson = (value: Schema.Json | undefined): string | undefined =>
  value === undefined ? undefined : Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(sortJson(value))

const sortJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value) === true) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}

export const readIds = (value: Schema.Json | undefined): ReadonlySet<string> => {
  if (Array.isArray(value) === false) return new Set()
  return new Set(
    value.flatMap((item) =>
      item !== null && typeof item === 'object' && Array.isArray(item) === false && typeof item.id === 'string'
        ? [item.id]
        : [],
    ),
  )
}

export const passedVerdict = (
  oracle: ScenarioOracle,
  evidence: ReadonlyArray<number>,
  summary: string,
): OracleVerdict => ({
  oracleId: oracle.id,
  oracle: oracle._tag,
  status: 'passed',
  summary,
  evidence,
})

export const failedVerdict = (
  oracle: ScenarioOracle,
  evidence: ReadonlyArray<number>,
  summary: string,
): OracleVerdict => ({
  oracleId: oracle.id,
  oracle: oracle._tag,
  status: 'failed',
  summary,
  evidence,
})
