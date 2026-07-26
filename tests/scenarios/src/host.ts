import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { SyncBackend, type UnknownError } from '@livestore/common'
import type { LiveStoreSchema } from '@livestore/common/schema'
import { createStore, type Store } from '@livestore/livestore'
import type { Schema } from '@livestore/utils/effect'
import { Effect, type OtelTracer, type Scope, SubscriptionRef } from '@livestore/utils/effect'

import {
  dispatchApplicationAction,
  inspectApplicationState,
  type ApplicationDefinition,
  ScenarioOperationError,
} from './application.ts'
import { makeConnectivityControlledBackend, type ScenarioBackend } from './backends.ts'
import { makeParticipantClock, readControllerOccurrence } from './clock.ts'
import type {
  CreateClientCommand,
  ClientLifecycleCommand,
  DispatchActionCommand,
  HostAcknowledgement,
  HostCapabilities,
  HostSystemObservation,
  InspectStateCommand,
  ObservedEvent,
  ParticipantRef,
  RuntimeFailureObservation,
  SetBackendAvailabilityCommand,
  SessionLifecycleCommand,
  SetConnectivityCommand,
  SyncObservation,
  SyncBackendRealization,
} from './model.ts'
import { participantKey } from './model.ts'
import { collectConfirmedEvents, makeComponentSyncObservation, makeEventRefRegistry } from './observations.ts'

export type HostError = ScenarioOperationError | UnknownError
export type HostServices = Scope.Scope | OtelTracer.OtelTracer

export interface ParticipantHost {
  readonly capabilities: HostCapabilities
  readonly backendId: SyncBackendRealization
  readonly componentVersions: Readonly<Record<string, string>>
  readonly createClient: (command: CreateClientCommand) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly dispatchAction: (
    command: DispatchActionCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly setConnectivity: (
    command: SetConnectivityCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly setBackendAvailability: (
    command: SetBackendAvailabilityCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly stopSession: (
    command: SessionLifecycleCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly restartSession: (
    command: SessionLifecycleCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly restartClient: (
    command: ClientLifecycleCommand,
  ) => Effect.Effect<HostAcknowledgement, HostError, HostServices>
  readonly observeSystem: Effect.Effect<HostSystemObservation, HostError, Scope.Scope>
  readonly drainRuntimeFailures: Effect.Effect<ReadonlyArray<RuntimeFailureObservation>, HostError, Scope.Scope>
  readonly observeSync: (participant: ParticipantRef) => Effect.Effect<SyncObservation, HostError, Scope.Scope>
  readonly inspectState: (command: InspectStateCommand) => Effect.Effect<Schema.Json, HostError>
}

export const inProcessHostCapabilities: HostCapabilities = {
  profile: 'in-process',
  capabilities: [
    'multiple-clients',
    'named-actions',
    'disconnect-reconnect',
    'backend-availability',
    'sync-observation',
    'system-observation',
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
export const makeInProcessHost = <TSchema extends LiveStoreSchema, TSyncMetadata>(args: {
  application: ApplicationDefinition<TSchema>
  backend: ScenarioBackend<TSyncMetadata>
}): Effect.Effect<ParticipantHost, UnknownError, Scope.Scope> =>
  Effect.gen(function* () {
    const eventRefs = makeEventRefRegistry()
    const observationClock = makeParticipantClock('in-process-host')
    let observedStoreId: string | undefined
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
        const underlying = yield* args.backend.makeBackend({
          storeId: command.storeId,
          clientId: command.client.id,
          payload: undefined,
        })
        const connectivity = yield* SubscriptionRef.make(command.client.initiallyConnected)
        const controlledBackend = makeConnectivityControlledBackend({
          clientId: command.client.id,
          connectivity,
          underlying,
        })

        const store = yield* createStore({
          schema: args.application.schema,
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
        observedStoreId ??= command.storeId
        return acknowledge(command.operationId)
      })

    const dispatchAction: ParticipantHost['dispatchAction'] = (command) =>
      Effect.gen(function* () {
        const store = yield* getStore(stores, command.target)
        yield* dispatchApplicationAction({
          application: args.application,
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

    const setBackendAvailability: ParticipantHost['setBackendAvailability'] = (command) =>
      args.backend.setAvailability(command.available).pipe(Effect.as(acknowledge(command.operationId)))

    const observeSync: ParticipantHost['observeSync'] = (participant) =>
      Effect.gen(function* () {
        const store = yield* getStore(stores, participant)
        return { participant, ...store.syncStatus() }
      })

    const observeSystem: ParticipantHost['observeSystem'] = Effect.gen(function* () {
      const backend =
        observedStoreId === undefined ? { connected: true, events: [] } : yield* args.backend.observe(observedStoreId)
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
          connected: backend.connected,
          head: `e${backend.events.at(-1)?.seqNum ?? 0}`,
          events: eventRefs.observeGlobalEvents(backend.events),
        },
        clients: clientObservations,
        occurrences: {
          backend: readControllerOccurrence(observationClock),
          clients: clientObservations.map((client) => ({
            clientId: client.clientId,
            connectivity: readControllerOccurrence(observationClock),
            leader: readControllerOccurrence(observationClock),
            sessions: client.sessions.map((session) => ({
              sessionId: session.sessionId,
              occurrence: readControllerOccurrence(observationClock),
            })),
          })),
        },
      }
    })

    const inspectState: ParticipantHost['inspectState'] = (command) =>
      Effect.gen(function* () {
        const store = yield* getStore(stores, command.target)
        return yield* inspectApplicationState({
          application: args.application,
          store,
          participant: command.target,
          inspector: command.inspector,
        })
      })

    return {
      capabilities: inProcessHostCapabilities,
      backendId: args.backend.id,
      componentVersions: {
        '@livestore/livestore': 'workspace',
        ...args.backend.componentVersions,
      },
      createClient,
      dispatchAction,
      setConnectivity,
      setBackendAvailability,
      stopSession: unsupportedLifecycle('session stop'),
      restartSession: unsupportedLifecycle('session restart'),
      restartClient: unsupportedLifecycle('Client restart'),
      observeSystem,
      drainRuntimeFailures: Effect.succeed([]),
      observeSync,
      inspectState,
    }
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

const unsupportedLifecycle = (operation: string) => (_command: { operationId: string }) =>
  Effect.fail(new ScenarioOperationError('capability-unavailable', `In-process host does not support ${operation}`))
