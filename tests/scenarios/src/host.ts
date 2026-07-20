import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { makeMockSyncBackend, SyncBackend, type UnknownError } from '@livestore/common'
import { EventSequenceNumber, type LiveStoreEvent, type LiveStoreSchema } from '@livestore/common/schema'
import { createStore, type Store } from '@livestore/livestore'
import { Effect, type OtelTracer, Schema, type Scope, Stream, SubscriptionRef } from '@livestore/utils/effect'

import {
  dispatchApplicationAction,
  inspectApplicationState,
  type ApplicationDefinition,
  ScenarioOperationError,
} from './application.ts'
import type {
  CreateClientCommand,
  DispatchActionCommand,
  HostAcknowledgement,
  HostCapabilities,
  HostSystemObservation,
  InspectStateCommand,
  ObservedEvent,
  ParticipantRef,
  SetConnectivityCommand,
  SyncObservation,
} from './model.ts'
import { participantKey } from './model.ts'

export type HostError = ScenarioOperationError | UnknownError
export type HostServices = Scope.Scope | OtelTracer.OtelTracer

export interface ParticipantHost {
  readonly capabilities: HostCapabilities
  readonly createClient: (command: CreateClientCommand) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly dispatchAction: (
    command: DispatchActionCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly setConnectivity: (
    command: SetConnectivityCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly observeSystem: Effect.Effect<HostSystemObservation, HostError>
  readonly observeSync: (participant: ParticipantRef) => Effect.Effect<SyncObservation, HostError>
  readonly inspectState: (command: InspectStateCommand) => Effect.Effect<Schema.Json, HostError>
}

export const inProcessHostCapabilities: HostCapabilities = {
  profile: 'in-process',
  capabilities: [
    'multiple-clients',
    'named-actions',
    'disconnect-reconnect',
    'sync-observation',
    'system-observation',
    'event-lineage',
    'state-inspection',
    'sqlite-state',
  ],
  maximumSessionsPerClient: 1,
  settlement: 'stable-poll',
}

/**
 * Creates the first production-shaped host: each Client owns a real in-memory
 * adapter leader and Store session while all Clients share one mock backend.
 */
export const makeInProcessHost = <TSchema extends LiveStoreSchema>(
  application: ApplicationDefinition<TSchema>,
): Effect.Effect<ParticipantHost, UnknownError, Scope.Scope> =>
  Effect.gen(function* () {
    const sharedBackend = yield* makeMockSyncBackend({ startConnected: true })
    const eventRefs = makeEventRefRegistry()
    const clients = new Map<
      string,
      {
        readonly connectivity: SubscriptionRef.SubscriptionRef<boolean>
        readonly sessionId: string
      }
    >()
    const stores = new Map<string, Store<TSchema>>()

    const createClient: ParticipantHost['createClient'] = (command) =>
      Effect.gen(function* () {
        if (clients.has(command.client.id) === true) {
          return yield* Effect.fail(
            new ScenarioOperationError('duplicate-client', `Client ${command.client.id} already exists`),
          )
        }
        if (command.client.sessions.length !== 1) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'capability-unavailable',
              `The in-process v1 host supports exactly one session per Client; ${command.client.id} requested ${command.client.sessions.length}`,
            ),
          )
        }

        const sessionId = command.client.sessions[0]!
        const underlying = yield* sharedBackend.makeSyncBackend
        const connectivity = yield* SubscriptionRef.make(command.client.initiallyConnected)
        const controlledBackend = makeConnectivityControlledBackend({
          clientId: command.client.id,
          connectivity,
          underlying,
        })

        const store = yield* createStore({
          schema: application.schema,
          storeId: command.storeId,
          adapter: makeInMemoryAdapter({
            clientId: command.client.id,
            sessionId,
            sync: {
              backend: () => Effect.succeed(controlledBackend),
              onSyncError: 'ignore',
            },
          }),
        })

        clients.set(command.client.id, { connectivity, sessionId })
        stores.set(participantKey({ clientId: command.client.id, sessionId }), store)
        return acknowledge(command.operationId)
      })

    const dispatchAction: ParticipantHost['dispatchAction'] = (command) =>
      Effect.gen(function* () {
        const store = yield* getStore(stores, command.target)
        yield* dispatchApplicationAction({
          application,
          store,
          participant: command.target,
          action: command.action,
          input: command.input,
        })
        return acknowledge(command.operationId)
      })

    const setConnectivity: ParticipantHost['setConnectivity'] = (command) =>
      Effect.gen(function* () {
        const client = clients.get(command.clientId)
        if (client === undefined) {
          return yield* Effect.fail(
            new ScenarioOperationError('missing-client', `Client ${command.clientId} does not exist`),
          )
        }
        yield* SubscriptionRef.set(client.connectivity, command.connected)
        return acknowledge(command.operationId)
      })

    const observeSync: ParticipantHost['observeSync'] = (participant) =>
      Effect.gen(function* () {
        const store = yield* getStore(stores, participant)
        return { participant, ...store.syncStatus() }
      })

    const observeSystem: ParticipantHost['observeSystem'] = Effect.gen(function* () {
      const backendEvents = yield* sharedBackend.events
      const backendConnected = yield* SubscriptionRef.get(sharedBackend.isConnected)
      const clientObservations = yield* Effect.forEach([...clients.entries()], ([clientId, client]) =>
        Effect.gen(function* () {
          const participant = { clientId, sessionId: client.sessionId }
          const store = yield* getStore(stores, participant)
          const connected = yield* SubscriptionRef.get(client.connectivity)
          const syncStates = yield* Effect.promise(() => store._dev.syncStates())
          const leaderConfirmed = yield* collectConfirmedEvents(store, syncStates.leader.upstreamHead)
          const sessionConfirmed = leaderConfirmed.filter(
            (event) => event.seqNum.global <= syncStates.session.upstreamHead.global,
          )

          return {
            clientId,
            connected,
            leader: makeComponentSyncObservation({
              confirmed: leaderConfirmed,
              pending: syncStates.leader.pending,
              localHead: syncStates.leader.localHead,
              upstreamHead: syncStates.leader.upstreamHead,
              eventRefs,
            }),
            sessions: [
              {
                sessionId: client.sessionId,
                sync: makeComponentSyncObservation({
                  confirmed: sessionConfirmed,
                  pending: syncStates.session.pending,
                  localHead: syncStates.session.localHead,
                  upstreamHead: syncStates.session.upstreamHead,
                  eventRefs,
                }),
              },
            ],
          }
        }),
      )

      return {
        backend: {
          id: 'sync-backend',
          connected: backendConnected,
          head: `e${backendEvents.at(-1)?.seqNum ?? 0}`,
          events: eventRefs.observeGlobalEvents(backendEvents),
        },
        clients: clientObservations,
      }
    })

    const inspectState: ParticipantHost['inspectState'] = (command) =>
      Effect.gen(function* () {
        const store = yield* getStore(stores, command.target)
        return yield* inspectApplicationState({
          application,
          store,
          participant: command.target,
          inspector: command.inspector,
        })
      })

    return {
      capabilities: inProcessHostCapabilities,
      createClient,
      dispatchAction,
      setConnectivity,
      observeSystem,
      observeSync,
      inspectState,
    }
  })

const makeConnectivityControlledBackend = (args: {
  clientId: string
  connectivity: SubscriptionRef.SubscriptionRef<boolean>
  underlying: SyncBackend.SyncBackend
}): SyncBackend.SyncBackend =>
  SyncBackend.of({
    ...args.underlying,
    connect: SubscriptionRef.set(args.connectivity, true),
    isConnected: args.connectivity,
    metadata: {
      ...args.underlying.metadata,
      name: '@local/scenario-controlled-mock-sync',
      description: `Scenario-controlled mock sync backend for ${args.clientId}`,
    },
  })

const getStore = <TSchema extends LiveStoreSchema>(
  stores: ReadonlyMap<string, Store<TSchema>>,
  participant: ParticipantRef,
): Effect.Effect<Store<TSchema>, ScenarioOperationError> => {
  const store = stores.get(participantKey(participant))
  return store === undefined
    ? Effect.fail(
        new ScenarioOperationError(
          'missing-participant',
          `Participant ${participant.clientId}/${participant.sessionId} does not exist`,
        ),
      )
    : Effect.succeed(store)
}

const acknowledge = (operationId: string): HostAcknowledgement => ({ operationId, status: 'acknowledged' })

type ClientEvent = LiveStoreEvent.Client.Encoded

const collectConfirmedEvents = <TSchema extends LiveStoreSchema>(
  store: Store<TSchema>,
  until: EventSequenceNumber.Client.Composite,
): Effect.Effect<ReadonlyArray<ClientEvent>, UnknownError> =>
  store.eventsStream({ until }).pipe(Stream.runCollectReadonlyArray) as Effect.Effect<
    ReadonlyArray<ClientEvent>,
    UnknownError
  >

const makeComponentSyncObservation = (args: {
  confirmed: ReadonlyArray<ClientEvent>
  pending: ReadonlyArray<LiveStoreEvent.Client.EncodedWithMeta>
  localHead: EventSequenceNumber.Client.Composite
  upstreamHead: EventSequenceNumber.Client.Composite
  eventRefs: EventRefRegistry
}) => ({
  localHead: EventSequenceNumber.Client.toString(args.localHead),
  upstreamHead: EventSequenceNumber.Client.toString(args.upstreamHead),
  pendingCount: args.pending.length,
  events: args.eventRefs.observeClientEvents(args.confirmed, args.pending),
})

interface EventRefRegistry {
  readonly observeClientEvents: (
    confirmed: ReadonlyArray<ClientEvent>,
    pending: ReadonlyArray<LiveStoreEvent.Client.Encoded>,
  ) => ReadonlyArray<ObservedEvent>
  readonly observeGlobalEvents: (events: ReadonlyArray<LiveStoreEvent.Global.Encoded>) => ReadonlyArray<ObservedEvent>
}

/**
 * Assigns one run-local reference to each origin occurrence while preserving
 * the actual LiveStore position observed at every component.
 */
const makeEventRefRegistry = (): EventRefRegistry => {
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
    events: ReadonlyArray<{ event: TraceableEvent; disposition: ObservedEvent['disposition'] }>,
    position: (event: TraceableEvent) => { position: string; parentPosition: string },
  ): ReadonlyArray<ObservedEvent> => {
    const occurrences = new Map<string, number>()
    return events.map(({ event, disposition }) => {
      const fingerprint = eventFingerprint(event)
      const occurrence = occurrences.get(fingerprint) ?? 0
      occurrences.set(fingerprint, occurrence + 1)
      return {
        eventRef: resolveRef(event, occurrence),
        name: event.name,
        args: normalizeJson(event.args),
        origin: { clientId: event.clientId, sessionId: event.sessionId },
        ...position(event),
        disposition,
      }
    })
  }

  return {
    observeClientEvents: (confirmed, pending) =>
      observe(
        [
          ...confirmed.map((event) => ({ event, disposition: 'confirmed' as const })),
          ...pending.map((event) => ({ event, disposition: 'pending' as const })),
        ],
        (event) => {
          const clientEvent = event as ClientEvent
          return {
            position: EventSequenceNumber.Client.toString(clientEvent.seqNum),
            parentPosition: EventSequenceNumber.Client.toString(clientEvent.parentSeqNum),
          }
        },
      ),
    observeGlobalEvents: (events) =>
      observe(
        events.map((event) => ({ event, disposition: 'confirmed' as const })),
        (event) => {
          const globalEvent = event as LiveStoreEvent.Global.Encoded
          return { position: `e${globalEvent.seqNum}`, parentPosition: `e${globalEvent.parentSeqNum}` }
        },
      ),
  }
}

type TraceableEvent = {
  readonly name: string
  readonly args: unknown
  readonly clientId: string
  readonly sessionId: string
  readonly seqNum: unknown
  readonly parentSeqNum: unknown
}

const eventFingerprint = (event: TraceableEvent): string =>
  JSON.stringify([event.clientId, event.sessionId, event.name, normalizeJson(event.args)])

const normalizeJson = Schema.decodeUnknownSync(Schema.Json)
