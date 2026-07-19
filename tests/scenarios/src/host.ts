import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { makeMockSyncBackend, SyncBackend, type UnknownError } from '@livestore/common'
import type { LiveStoreSchema } from '@livestore/common/schema'
import { createStore, type Store } from '@livestore/livestore'
import { Effect, type OtelTracer, type Schema, type Scope, SubscriptionRef } from '@livestore/utils/effect'

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
  InspectStateCommand,
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
