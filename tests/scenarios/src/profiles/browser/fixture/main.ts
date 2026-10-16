import { unstable_batchedUpdates } from 'react-dom'

import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { createStorePromise, type Store, StoreInternalsSymbol } from '@livestore/livestore'
import { Effect } from '@livestore/utils/effect'

import { dispatchApplicationAction, inspectApplicationState } from '../../../application/definition.ts'
import { makeParticipantClock, type ParticipantClock } from '../../../clock.ts'
import { getScenarioApplication, type RegisteredApplication } from '../../../corpus/applications/registry.ts'
import { collectConfirmedEvents, makeComponentSyncObservation, makeEventRefRegistry } from '../../../observations.ts'
import type { BrowserPageObservation, BrowserStartOptions, ScenarioBrowserControl } from '../protocol.ts'
import { mountScenarioApp } from './app.tsx'
import { startFrameMonitor } from './frame-monitor.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'

interface BrowserRuntime {
  readonly application: RegisteredApplication
  readonly options: BrowserStartOptions
  readonly store: Store<RegisteredApplication['schema']>
  readonly app: { readonly unmount: () => void }
}

let runtime: BrowserRuntime | undefined
let participantClock: ParticipantClock | undefined
// Started at load so frames before and during startup are measured too; drains report only what is new.
const frameMonitor = startFrameMonitor()

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const requireRuntime = (): BrowserRuntime => {
  if (runtime === undefined) throw new Error('Browser participant has not started')
  return runtime
}

const start = async (options: BrowserStartOptions): Promise<void> => {
  if (runtime !== undefined) throw new Error('Browser participant is already running')
  const application = getScenarioApplication(options.applicationId)
  const store = await createStorePromise({
    schema: application.schema,
    storeId: options.storeId,
    disableDevtools: false,
    // Real React apps pass React's batching so one LiveStore refresh renders once.
    batchUpdates: unstable_batchedUpdates,
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
  const label = `${options.clientId}/${options.sessionId}`
  const app = mountScenarioApp({ applicationId: options.applicationId, store, label })
  runtime = { application, options, store, app }
  participantClock = makeParticipantClock(`browser-session:${label}`)
}

const observe = async (): Promise<BrowserPageObservation> => {
  const current = requireRuntime()
  const clock = participantClock
  if (clock === undefined) throw new Error('Browser participant clock has not started')
  const sync = current.store.syncStatus()
  const syncStates = await current.store._dev.syncStates()
  const eventRefs = makeEventRefRegistry()
  const leaderConfirmed = await run(collectConfirmedEvents(current.store, syncStates.leader.upstreamHead))
  const sessionConfirmed = leaderConfirmed.filter(
    (event) => event.seqNum.global <= syncStates.session.upstreamHead.global,
  )
  const participant = { clientId: current.options.clientId, sessionId: current.options.sessionId }

  return {
    leader: makeComponentSyncObservation({
      confirmed: leaderConfirmed,
      pending: syncStates.leader.pending,
      localHead: syncStates.leader.localHead,
      upstreamHead: syncStates.leader.upstreamHead,
      eventRefs,
    }),
    session: makeComponentSyncObservation({
      confirmed: sessionConfirmed,
      pending: syncStates.session.pending,
      localHead: syncStates.session.localHead,
      upstreamHead: syncStates.session.upstreamHead,
      eventRefs,
    }),
    sync: { participant, ...sync },
    clock: clock.read(),
  }
}

const control: ScenarioBrowserControl = {
  start,
  setConnectivity: (connected) => frameMonitor.harness('set-connectivity', () => setConnectivity(connected)),
  captureDatabaseDiagnostics: () => frameMonitor.harness('capture-diagnostics', captureDatabaseDiagnostics),
  dispatchAction: (args) => frameMonitor.harness('dispatch-action', () => dispatchAction(args)),
  observe: () => frameMonitor.harness('observe', observe),
  inspectState: (args) => frameMonitor.harness('inspect-state', () => inspectState(args)),
  probeSync: () =>
    frameMonitor.harness('probe-sync', async () => {
      const states = await requireRuntime().store._dev.syncStates()
      return {
        sessionPending: states.session.pending.length,
        leaderPending: states.leader.pending.length,
        leaderUpstreamGlobal: states.leader.upstreamHead.global,
      }
    }),
  drainFrameTiming: async () => {
    const clock = participantClock
    if (clock === undefined) throw new Error('Browser participant clock has not started')
    // Read the clock right next to the drain so relative frame times share its instant.
    const timing = frameMonitor.drain()
    return { timing, clock: clock.read() }
  },
  shutdown: async () => {
    const current = runtime
    runtime = undefined
    participantClock = undefined
    frameMonitor.stop()
    current?.app.unmount()
    if (current !== undefined) await current.store.shutdownPromise()
  },
}

const setConnectivity: ScenarioBrowserControl['setConnectivity'] = async (connected) => {
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
}

const captureDatabaseDiagnostics: ScenarioBrowserControl['captureDatabaseDiagnostics'] = async () => {
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
}

const dispatchAction: ScenarioBrowserControl['dispatchAction'] = async ({ target, action, input }) => {
  const current = requireRuntime()
  await run(
    dispatchApplicationAction({
      application: current.application,
      store: current.store,
      participant: target,
      action,
      input,
    }),
  )
}

const inspectState: ScenarioBrowserControl['inspectState'] = async ({ participant, inspector }) => {
  const current = requireRuntime()
  return run(
    inspectApplicationState({
      application: current.application,
      store: current.store,
      participant,
      inspector,
    }),
  )
}

window.__scenarioBrowser = control

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
