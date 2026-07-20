import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Effect } from '@livestore/utils/effect'

import { dispatchApplicationAction, inspectApplicationState } from '../../application.ts'
import { todoApplication } from '../../fixtures/todo-application.ts'
import type { BrowserPageObservation, BrowserStartOptions, ScenarioBrowserControl } from '../protocol.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'

interface BrowserRuntime {
  readonly options: BrowserStartOptions
  readonly store: Store<typeof todoApplication.schema>
}

let runtime: BrowserRuntime | undefined

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
  document.querySelector('#status')!.textContent = `${options.clientId}/${options.sessionId}`
}

const observe = async (): Promise<BrowserPageObservation> => {
  const current = requireRuntime()
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
  }
}

const control: ScenarioBrowserControl = {
  start,
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
    if (current !== undefined) await current.store.shutdownPromise()
  },
}

window.__scenarioBrowser = control
