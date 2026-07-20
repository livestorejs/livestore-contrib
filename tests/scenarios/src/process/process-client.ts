import process from 'node:process'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { OtelLiveDummy } from '@livestore/common'
import { createStore, type Store } from '@livestore/livestore'
import { makeWsSync } from '@livestore/sync-cf/client'
import {
  Effect,
  Exit,
  FetchHttpClient,
  KeyValueStore,
  type OtelTracer,
  Scope,
  SubscriptionRef,
} from '@livestore/utils/effect'

import { dispatchApplicationAction, inspectApplicationState } from '../application.ts'
import { getScenarioApplication } from '../applications.ts'
import { makeConnectivityControlledBackend } from '../backends.ts'
import type { ClientSystemObservation, ParticipantRef, SyncObservation } from '../model.ts'
import { collectConfirmedEvents, makeComponentSyncObservation, makeEventRefRegistry } from '../observations.ts'
import type { ProcessClientRequest, ProcessClientResponse, ProcessClientResult } from './protocol.ts'

type RegisteredApplication = ReturnType<typeof getScenarioApplication>

interface ClientRuntime {
  readonly application: RegisteredApplication
  readonly clientId: string
  readonly sessionId: string
  readonly store: Store<RegisteredApplication['schema']>
  readonly connectivity: SubscriptionRef.SubscriptionRef<boolean>
}

const scope = await Effect.runPromise(Scope.make())
let runtime: ClientRuntime | undefined
let requestChain = Promise.resolve()

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | OtelTracer.OtelTracer>) =>
  Effect.runPromise(effect.pipe(Scope.provide(scope), Effect.provide(OtelLiveDummy)))

const requireRuntime = (): ClientRuntime => {
  if (runtime === undefined) throw new Error('Process Client has not been initialized')
  return runtime
}

const handle = async (request: ProcessClientRequest): Promise<ProcessClientResult> => {
  switch (request.command._tag) {
    case 'initialize': {
      if (runtime !== undefined) throw new Error('Process Client is already initialized')
      if (request.command.client.sessions.length !== 1) {
        throw new Error('Process profile currently supports exactly one session per Client')
      }
      if (request.command.backend._tag !== 'sync-cf-ws') {
        throw new Error('Process profile currently requires the local sync-cf backend')
      }

      const application = getScenarioApplication(request.command.applicationId)
      const clientId = request.command.client.id
      const sessionId = request.command.client.sessions[0]!
      const connectivity = await run(SubscriptionRef.make(request.command.client.initiallyConnected))
      const makeBackend = makeWsSync({ url: request.command.backend.url })
      const underlying = await run(
        makeBackend({
          storeId: `${request.command.storeId}-${request.command.backend.storeIdSuffix}`,
          clientId,
          payload: undefined,
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(KeyValueStore.layerMemory)),
      )
      const backend = makeConnectivityControlledBackend({ clientId, connectivity, underlying })
      const store = await run(
        createStore({
          schema: application.schema,
          storeId: request.command.storeId,
          adapter: makeInMemoryAdapter({
            clientId,
            sessionId,
            sync: { backend: () => Effect.succeed(backend), onSyncError: 'ignore' },
          }),
        }),
      )

      runtime = { application, clientId, sessionId, store, connectivity }
      return { _tag: 'initialized', pid: process.pid }
    }
    case 'dispatch-action': {
      const current = requireRuntime()
      await run(
        dispatchApplicationAction({
          application: current.application,
          store: current.store,
          participant: request.command.target,
          action: request.command.action,
          input: request.command.input,
        }),
      )
      return { _tag: 'acknowledged' }
    }
    case 'set-connectivity': {
      const current = requireRuntime()
      await run(SubscriptionRef.set(current.connectivity, request.command.connected))
      return { _tag: 'acknowledged' }
    }
    case 'observe-client':
      return { _tag: 'client-observation', observation: await observeClient() }
    case 'observe-sync':
      return { _tag: 'sync-observation', observation: observeSync(request.command.participant) }
    case 'inspect-state': {
      const current = requireRuntime()
      const value = await run(
        inspectApplicationState({
          application: current.application,
          store: current.store,
          participant: request.command.participant,
          inspector: request.command.inspector,
        }),
      )
      return { _tag: 'state', value }
    }
    case 'shutdown': {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      return { _tag: 'acknowledged' }
    }
  }
}

const observeClient = async (): Promise<ClientSystemObservation> => {
  const current = requireRuntime()
  const eventRefs = makeEventRefRegistry()
  const connected = await run(SubscriptionRef.get(current.connectivity))
  const syncStates = await current.store._dev.syncStates()
  const leaderConfirmed = await run(collectConfirmedEvents(current.store, syncStates.leader.upstreamHead))
  const sessionConfirmed = leaderConfirmed.filter(
    (event) => event.seqNum.global <= syncStates.session.upstreamHead.global,
  )

  return {
    clientId: current.clientId,
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
        sessionId: current.sessionId,
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
}

const observeSync = (participant: ParticipantRef): SyncObservation => {
  const current = requireRuntime()
  assertParticipant(current, participant)
  return { participant, ...current.store.syncStatus() }
}

const assertParticipant = (current: ClientRuntime, participant: ParticipantRef) => {
  if (participant.clientId !== current.clientId || participant.sessionId !== current.sessionId) {
    throw new Error(`Unknown participant ${participant.clientId}/${participant.sessionId}`)
  }
}

const respond = (response: ProcessClientResponse) => {
  if (process.send === undefined) throw new Error('Process Client requires an IPC channel')
  process.send(response)
}

process.on('message', (message: ProcessClientRequest) => {
  requestChain = requestChain.then(async () => {
    try {
      const result = await handle(message)
      respond({ requestId: message.requestId, status: 'success', result })
      if (message.command._tag === 'shutdown') process.exit(0)
    } catch (cause) {
      const error = cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack ?? ''}` : String(cause)
      respond({ requestId: message.requestId, status: 'failure', error })
    }
  })
})

process.on('SIGTERM', () => {
  Effect.runPromise(Scope.close(scope, Exit.void)).finally(() => process.exit(0))
})
