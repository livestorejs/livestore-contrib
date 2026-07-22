import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { createStorePromise, type Store, StoreInternalsSymbol } from '@livestore/livestore'
import { Effect } from '@livestore/utils/effect'

import { dispatchApplicationAction, inspectApplicationState } from '../../application.ts'
import { makeParticipantClock, type ParticipantClock } from '../../clock.ts'
import { todoApplication } from '../../fixtures/todo-application.ts'
import type { BrowserPageObservation, BrowserStartOptions, ScenarioBrowserControl } from '../protocol.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'

interface BrowserRuntime {
  readonly options: BrowserStartOptions
  readonly store: Store<typeof todoApplication.schema>
}

let runtime: BrowserRuntime | undefined
let participantClock: ParticipantClock | undefined

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const requireRuntime = (): BrowserRuntime => {
  if (runtime === undefined) throw new Error('Browser participant has not started')
  return runtime
}

const start = async (options: BrowserStartOptions): Promise<void> => {
  if (runtime !== undefined) throw new Error('Browser participant is already running')
  const store = await createStorePromise({
    schema: todoApplication.schema,
    storeId: options.storeId,
    disableDevtools: false,
    adapter: makePersistedAdapter({
      storage: { type: 'opfs' },
      worker: LiveStoreWorker,
      sharedWorker: LiveStoreSharedWorker,
      clientId: options.clientId,
      sessionId: options.sessionId,
      // Scenario pages intentionally boot and stop close together. Waiting for the
      // SharedWorker lock and avoiding an unlocked OPFS fast-path read makes that
      // lifecycle deterministic while retaining the production worker topology.
      experimental: { disableFastPath: true, awaitSharedWorkerTermination: true },
    }),
  }).catch((error: unknown) => {
    const underlying = error instanceof Error ? error.cause : undefined
    const detail = underlying instanceof Error ? (underlying.stack ?? underlying.message) : String(underlying ?? error)
    throw new Error(`LiveStore startup failed for ${options.clientId}/${options.sessionId}: ${detail}`, {
      cause: error,
    })
  })
  runtime = { options, store }
  participantClock = makeParticipantClock(`browser-session:${options.clientId}/${options.sessionId}`)
  document.querySelector('#status')!.textContent = `${options.clientId}/${options.sessionId}`
}

const observe = async (): Promise<BrowserPageObservation> => {
  const current = requireRuntime()
  const clock = participantClock
  if (clock === undefined) throw new Error('Browser participant clock has not started')
  const sync = current.store.syncStatus()
  const participant = { clientId: current.options.clientId, sessionId: current.options.sessionId }
  const component = {
    localHead: sync.localHead,
    upstreamHead: sync.upstreamHead,
    pendingCount: sync.pendingCount,
    events: [],
  }

  return {
    leader: component,
    session: component,
    sync: { participant, ...sync },
    clock: clock.read(),
  }
}

const control: ScenarioBrowserControl = {
  start,
  setConnectivity: async (connected) => {
    const current = requireRuntime()
    current.store._dev.overrideNetworkStatus(connected === true ? 'online' : 'offline')
    const expectedLatchClosed = connected === false
    const deadline = performance.now() + 2_000
    while (performance.now() < deadline) {
      const status = await run(current.store.networkStatus)
      if (status.devtools.latchClosed === expectedLatchClosed) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`LiveStore sync latch did not become ${connected === true ? 'online' : 'offline'}`)
  },
  captureDatabaseDiagnostics: async () => {
    const current = requireRuntime()
    const internals = current.store[StoreInternalsSymbol]
    const [leaderState, eventlog, syncStates] = await Promise.all([
      run(internals.clientSession.leaderThread.export),
      run(internals.clientSession.leaderThread.getEventlogData),
      current.store._dev.syncStates(),
    ])
    return {
      sessionStateBase64: bytesToBase64(internals.sqliteDbWrapper.export()),
      leaderStateBase64: bytesToBase64(leaderState),
      eventlogBase64: bytesToBase64(eventlog),
      syncStates: { session: syncStates.session.toJSON(), leader: syncStates.leader.toJSON() },
    }
  },
  dispatchAction: async ({ target, action, input }) => {
    const current = requireRuntime()
    await run(
      dispatchApplicationAction({
        application: todoApplication,
        store: current.store,
        participant: target,
        action,
        input,
      }),
    )
  },
  observe,
  inspectState: async ({ participant, inspector }) => {
    const current = requireRuntime()
    return run(
      inspectApplicationState({
        application: todoApplication,
        store: current.store,
        participant,
        inspector,
      }),
    )
  },
  shutdown: async () => {
    const current = runtime
    runtime = undefined
    participantClock = undefined
    if (current !== undefined) await current.store.shutdownPromise()
  },
}

window.__scenarioBrowser = control

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
