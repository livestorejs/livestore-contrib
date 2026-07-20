import type { UnknownError } from '@livestore/common'
import { EventSequenceNumber, type LiveStoreEvent, type LiveStoreSchema } from '@livestore/common/schema'
import type { Store } from '@livestore/livestore'
import { Effect, Schema, Stream } from '@livestore/utils/effect'

import type { ComponentSyncObservation, ObservedEvent } from './model.ts'

type ClientEvent = LiveStoreEvent.Client.Encoded

export interface EventRefRegistry {
  readonly observeClientEvents: (
    confirmed: ReadonlyArray<ClientEvent>,
    pending: ReadonlyArray<LiveStoreEvent.Client.Encoded>,
  ) => ReadonlyArray<ObservedEvent>
  readonly observeGlobalEvents: (events: ReadonlyArray<LiveStoreEvent.Global.Encoded>) => ReadonlyArray<ObservedEvent>
  readonly reconcileObservedEvents: (events: ReadonlyArray<ObservedEvent>) => ReadonlyArray<ObservedEvent>
}

/** Assigns one runner-owned reference to each origin occurrence across every component. */
export const makeEventRefRegistry = (): EventRefRegistry => {
  const refs = new Map<string, string>()
  let nextRef = 1

  const resolveRef = (event: TraceableEvent, occurrence: number): string => {
    const lineageKey = `${eventFingerprint(event)}\u0000${occurrence}`
    const existing = refs.get(lineageKey)
    if (existing !== undefined) return existing
    const eventRef = `event-${String(nextRef).padStart(4, '0')}`
    nextRef += 1
    refs.set(lineageKey, eventRef)
    return eventRef
  }

  const observe = (
    events: ReadonlyArray<{
      event: TraceableEvent
      disposition: ObservedEvent['disposition']
      position: string
      parentPosition: string
    }>,
  ): ReadonlyArray<ObservedEvent> => {
    const occurrences = new Map<string, number>()
    return events.map(({ event, disposition, position, parentPosition }) => {
      const fingerprint = eventFingerprint(event)
      const occurrence = occurrences.get(fingerprint) ?? 0
      occurrences.set(fingerprint, occurrence + 1)
      return {
        eventRef: resolveRef(event, occurrence),
        name: event.name,
        args: normalizeJson(event.args),
        origin: { clientId: event.clientId, sessionId: event.sessionId },
        position,
        parentPosition,
        disposition,
      }
    })
  }

  return {
    observeClientEvents: (confirmed, pending) =>
      observe([
        ...confirmed.map((event) => ({
          event,
          disposition: 'confirmed' as const,
          position: EventSequenceNumber.Client.toString(event.seqNum),
          parentPosition: EventSequenceNumber.Client.toString(event.parentSeqNum),
        })),
        ...pending.map((event) => ({
          event,
          disposition: 'pending' as const,
          position: EventSequenceNumber.Client.toString(event.seqNum),
          parentPosition: EventSequenceNumber.Client.toString(event.parentSeqNum),
        })),
      ]),
    observeGlobalEvents: (events) =>
      observe(
        events.map((event) => ({
          event,
          disposition: 'confirmed' as const,
          position: `e${event.seqNum}`,
          parentPosition: `e${event.parentSeqNum}`,
        })),
      ),
    reconcileObservedEvents: (events) =>
      observe(
        events.map((event) => ({
          event: { ...event, clientId: event.origin.clientId, sessionId: event.origin.sessionId },
          disposition: event.disposition,
          position: event.position,
          parentPosition: event.parentPosition,
        })),
      ),
  }
}

export const collectConfirmedEvents = <TSchema extends LiveStoreSchema>(
  store: Store<TSchema>,
  until: EventSequenceNumber.Client.Composite,
): Effect.Effect<ReadonlyArray<ClientEvent>, UnknownError> =>
  store.eventsStream({ until }).pipe(Stream.runCollectReadonlyArray) as Effect.Effect<
    ReadonlyArray<ClientEvent>,
    UnknownError
  >

export const makeComponentSyncObservation = (args: {
  confirmed: ReadonlyArray<ClientEvent>
  pending: ReadonlyArray<LiveStoreEvent.Client.EncodedWithMeta>
  localHead: EventSequenceNumber.Client.Composite
  upstreamHead: EventSequenceNumber.Client.Composite
  eventRefs: EventRefRegistry
}): ComponentSyncObservation => ({
  localHead: EventSequenceNumber.Client.toString(args.localHead),
  upstreamHead: EventSequenceNumber.Client.toString(args.upstreamHead),
  pendingCount: args.pending.length,
  events: args.eventRefs.observeClientEvents(args.confirmed, args.pending),
})

type TraceableEvent = {
  readonly name: string
  readonly args: unknown
  readonly clientId: string
  readonly sessionId: string
}

const eventFingerprint = (event: TraceableEvent): string =>
  JSON.stringify([event.clientId, event.sessionId, event.name, normalizeJson(event.args)])

const normalizeJson = Schema.decodeUnknownSync(Schema.Json)
