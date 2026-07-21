import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

import { EventSequenceNumber, type LiveStoreEvent } from '@livestore/common/schema'
import { Effect, Schema, type Scope } from '@livestore/utils/effect'

import { ScenarioOperationError } from '../application.ts'
import type { ScenarioBackend } from '../backends.ts'
import type { ParticipantHost } from '../host.ts'
import {
  type ClientSystemObservation,
  ClientSystemObservation as ClientSystemObservationSchema,
  type HostAcknowledgement,
  type HostCapabilities,
  type ParticipantRef,
  SyncObservation as SyncObservationSchema,
} from '../model.ts'
import { makeEventRefRegistry } from '../observations.ts'
import type { BrowserPageObservation, BrowserStartOptions } from './protocol.ts'

export const browserHostCapabilities: HostCapabilities = {
  profile: 'browser',
  capabilities: [
    'multiple-clients',
    'multiple-sessions',
    'named-actions',
    'disconnect-reconnect',
    'sync-observation',
    'system-observation',
    'event-lineage',
    'state-inspection',
    'opfs-state',
    'session-restart',
    'client-restart',
    'browser-shared-worker',
    'browser-web-locks',
  ],
  maximumSessionsPerClient: 8,
  settlement: 'stable-poll',
}

export const makeBrowserHost = (args: {
  applicationId: string
  backend: Pick<ScenarioBackend, 'id' | 'observe' | 'serializedConfig' | 'componentVersions'>
}): Effect.Effect<ParticipantHost, ScenarioOperationError, Scope.Scope> =>
  Effect.gen(function* () {
    if (args.applicationId !== 'scenario-todo-app') {
      return yield* Effect.fail(
        new ScenarioOperationError('application-mismatch', `Browser fixture does not provide ${args.applicationId}`),
      )
    }
    if (args.backend.serializedConfig._tag !== 'sync-cf-ws') {
      return yield* Effect.fail(
        new ScenarioOperationError('capability-unavailable', 'Browser profile currently requires local sync-cf'),
      )
    }

    const server = yield* startFixtureServer({
      backendUrl: args.backend.serializedConfig.url,
      storeIdSuffix: args.backend.serializedConfig.storeIdSuffix,
    })
    const clients = new Map<string, BrowserClientController>()
    const eventRefs = makeEventRefRegistry()
    let observedStoreId: string | undefined

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...clients.values()], (client) => client.shutdown, {
        discard: true,
        concurrency: 'unbounded',
      }).pipe(Effect.orDie),
    )

    const createClient: ParticipantHost['createClient'] = (command) =>
      Effect.gen(function* () {
        if (clients.has(command.client.id) === true) {
          return yield* Effect.fail(
            new ScenarioOperationError('duplicate-client', `Client ${command.client.id} already exists`),
          )
        }
        if (command.client.sessions.length > browserHostCapabilities.maximumSessionsPerClient) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'capability-unavailable',
              `Browser profile supports at most ${browserHostCapabilities.maximumSessionsPerClient} sessions per Client`,
            ),
          )
        }
        const controller = yield* makeBrowserClient({
          baseUrl: server.baseUrl,
          storeId: command.storeId,
          clientId: command.client.id,
          sessionIds: command.client.sessions,
          initiallyConnected: command.client.initiallyConnected,
        })
        clients.set(command.client.id, controller)
        observedStoreId ??= command.storeId
        return acknowledge(command.operationId)
      })

    const dispatchAction: ParticipantHost['dispatchAction'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.target.clientId)
        const page = yield* client.getSession(command.target.sessionId)
        yield* dispatchPageAction(page, {
          target: command.target,
          action: command.action,
          input: command.input,
        })
        return acknowledge(command.operationId)
      })

    const setConnectivity: ParticipantHost['setConnectivity'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.clientId)
        yield* client.setConnectivity(command.connected)
        return acknowledge(command.operationId)
      })

    const stopSession: ParticipantHost['stopSession'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.target.clientId)
        yield* client.stopSession(command.target.sessionId)
        return acknowledge(command.operationId)
      })

    const restartSession: ParticipantHost['restartSession'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.target.clientId)
        yield* client.restartSession(command.target.sessionId)
        return acknowledge(command.operationId)
      })

    const restartClient: ParticipantHost['restartClient'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.clientId)
        yield* client.restart
        return acknowledge(command.operationId)
      })

    const observeSystem: ParticipantHost['observeSystem'] = Effect.gen(function* () {
      const backend =
        observedStoreId === undefined ? { connected: true, events: [] } : yield* args.backend.observe(observedStoreId)
      const backendHead = backend.events.at(-1)?.seqNum ?? 0
      const clientObservations = yield* Effect.forEach(
        [...clients.values()],
        (client) =>
          client.observe.pipe(
            Effect.map(reconcileClientObservation(eventRefs)),
            Effect.map((observation) => hydrateConfirmedEvents(observation, backend.events, eventRefs)),
            Effect.map((observation) => deriveLeaderObservation(observation, backendHead)),
          ),
        { concurrency: 'unbounded' },
      )
      return yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          backend: Schema.Struct({
            id: Schema.String,
            connected: Schema.Boolean,
            head: Schema.String,
            events: Schema.Array(Schema.Any),
          }),
          clients: Schema.Array(ClientSystemObservationSchema),
        }),
      )({
        backend: {
          id: 'sync-backend',
          connected: backend.connected,
          head: `e${backendHead}`,
          events: eventRefs.observeGlobalEvents(backend.events),
        },
        clients: clientObservations,
      }).pipe(Effect.mapError((cause) => browserError(`Invalid browser system observation: ${String(cause)}`)))
    })

    const observeSync: ParticipantHost['observeSync'] = (participant) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, participant.clientId)
        const page = yield* client.getSession(participant.sessionId)
        const observation = yield* observePage(page)
        if (observedStoreId === undefined) return yield* Effect.fail(browserError('Browser store is not initialized'))
        const backend = yield* args.backend.observe(observedStoreId)
        const backendHead = backend.events.at(-1)?.seqNum ?? 0
        const leaderHead = EventSequenceNumber.Client.fromString(observation.sync.upstreamHead)
        const pendingCount = Math.max(observation.sync.pendingCount, leaderHead.client)
        return yield* Schema.decodeUnknownEffect(SyncObservationSchema)({
          participant,
          localHead: observation.sync.upstreamHead,
          upstreamHead: `e${backendHead}`,
          pendingCount,
          isSynced: client.connected() === true && pendingCount === 0 && leaderHead.global === backendHead,
        }).pipe(Effect.mapError((cause) => browserError(`Invalid browser sync observation: ${String(cause)}`)))
      })

    const inspectState: ParticipantHost['inspectState'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.target.clientId)
        const page = yield* client.getSession(command.target.sessionId)
        return yield* inspectPageState(page, {
          participant: command.target,
          inspector: command.inspector,
        })
      })

    return {
      capabilities: browserHostCapabilities,
      backendId: args.backend.id,
      componentVersions: {
        '@livestore/adapter-web': 'workspace',
        '@livestore/livestore': 'workspace',
        ...args.backend.componentVersions,
        chromium: chromium.name(),
      },
      createClient,
      dispatchAction,
      setConnectivity,
      stopSession,
      restartSession,
      restartClient,
      observeSystem,
      observeSync,
      inspectState,
    }
  })

interface BrowserClientController {
  readonly clientId: string
  readonly connected: () => boolean
  readonly getSession: (sessionId: string) => Effect.Effect<Page, ScenarioOperationError>
  readonly setConnectivity: (connected: boolean) => Effect.Effect<void, ScenarioOperationError>
  readonly stopSession: (sessionId: string) => Effect.Effect<void, ScenarioOperationError>
  readonly restartSession: (sessionId: string) => Effect.Effect<void, ScenarioOperationError>
  readonly restart: Effect.Effect<void, ScenarioOperationError>
  readonly observe: Effect.Effect<ClientSystemObservation, ScenarioOperationError>
  readonly shutdown: Effect.Effect<void, ScenarioOperationError>
}

const makeBrowserClient = (args: {
  baseUrl: string
  storeId: string
  clientId: string
  sessionIds: ReadonlyArray<string>
  initiallyConnected: boolean
}): Effect.Effect<BrowserClientController, ScenarioOperationError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const userDataDir = yield* Effect.tryPromise({
        try: () => fs.mkdtemp(path.join(os.tmpdir(), `livestore-scenario-${args.clientId}-`)),
        catch: (cause) => browserError(`Failed to create browser profile: ${String(cause)}`),
      })
      const state = {
        context: yield* launchBrowserContext(userDataDir),
        connected: args.initiallyConnected,
        pages: new Map<string, Page>(),
      }
      let shutdownComplete = false

      for (const sessionId of args.sessionIds) {
        const page = yield* startSessionPage({ ...args, context: state.context, sessionId })
        state.pages.set(sessionId, page)
      }
      if (state.connected === false) yield* setContextOffline(state.context, true)

      const getSession = (sessionId: string): Effect.Effect<Page, ScenarioOperationError> => {
        const page = state.pages.get(sessionId)
        return page === undefined
          ? Effect.fail(browserError(`Session ${args.clientId}/${sessionId} is not running`))
          : Effect.succeed(page)
      }

      const stopSession = (sessionId: string) =>
        Effect.gen(function* () {
          const page = yield* getSession(sessionId)
          yield* shutdownPage(page)
          state.pages.delete(sessionId)
        })

      const restartSession = (sessionId: string) =>
        Effect.gen(function* () {
          if (args.sessionIds.includes(sessionId) === false) {
            return yield* Effect.fail(browserError(`Unknown session ${args.clientId}/${sessionId}`))
          }
          if (state.pages.has(sessionId) === true) {
            return yield* Effect.fail(browserError(`Session ${args.clientId}/${sessionId} is already running`))
          }
          const page = yield* startSessionPage({ ...args, context: state.context, sessionId })
          state.pages.set(sessionId, page)
        })

      const setConnectivity = (connected: boolean) =>
        setContextOffline(state.context, connected === false).pipe(
          Effect.tap(() => Effect.sync(() => (state.connected = connected))),
        )

      const restart = Effect.gen(function* () {
        yield* closePages(state.pages)
        yield* closeContext(state.context)
        state.context = yield* launchBrowserContext(userDataDir)
        for (const sessionId of args.sessionIds) {
          const page = yield* startSessionPage({ ...args, context: state.context, sessionId })
          state.pages.set(sessionId, page)
        }
        if (state.connected === false) yield* setContextOffline(state.context, true)
      })

      const observe = Effect.gen(function* () {
        const observations = yield* Effect.forEach(
          [...state.pages.entries()],
          ([sessionId, page]) => observePage(page).pipe(Effect.map((observation) => ({ sessionId, observation }))),
          { concurrency: 'unbounded' },
        )
        const leader = observations[0]?.observation.leader
        if (leader === undefined)
          return yield* Effect.fail(browserError(`Client ${args.clientId} has no running session`))
        return yield* Schema.decodeUnknownEffect(ClientSystemObservationSchema)({
          clientId: args.clientId,
          connected: state.connected,
          leader,
          sessions: observations.map(({ sessionId, observation }) => ({ sessionId, sync: observation.session })),
        }).pipe(Effect.mapError((cause) => browserError(`Invalid Client observation: ${String(cause)}`)))
      })

      const shutdown = Effect.gen(function* () {
        if (shutdownComplete === true) return
        shutdownComplete = true
        yield* closePages(state.pages)
        yield* closeContext(state.context)
        yield* Effect.tryPromise({
          try: () => fs.rm(userDataDir, { recursive: true, force: true }),
          catch: (cause) => browserError(`Failed to remove browser profile ${userDataDir}: ${String(cause)}`),
        })
      })

      return {
        clientId: args.clientId,
        connected: () => state.connected,
        getSession,
        setConnectivity,
        stopSession,
        restartSession,
        restart,
        observe,
        shutdown,
      }
    }),
    (controller) => controller.shutdown.pipe(Effect.ignore),
  )

const startSessionPage = (args: {
  context: BrowserContext
  baseUrl: string
  storeId: string
  clientId: string
  sessionId: string
}): Effect.Effect<Page, ScenarioOperationError> =>
  Effect.tryPromise({
    try: async () => {
      const page = await args.context.newPage()
      page.on('console', (message) => {
        if (message.type() === 'error') console.error(`[browser ${args.clientId}/${args.sessionId}] ${message.text()}`)
      })
      page.on('pageerror', (error) => console.error(`[browser ${args.clientId}/${args.sessionId}]`, error))
      await page.goto(args.baseUrl)
      await page.waitForFunction(() => window.__scenarioBrowser !== undefined)
      const options: BrowserStartOptions = {
        storeId: args.storeId,
        clientId: args.clientId,
        sessionId: args.sessionId,
      }
      await page.evaluate((input) => window.__scenarioBrowser.start(input), options)
      return page
    },
    catch: (cause) => browserError(`Failed to start ${args.clientId}/${args.sessionId}: ${String(cause)}`),
  })

const launchBrowserContext = (userDataDir: string): Effect.Effect<BrowserContext, ScenarioOperationError> =>
  Effect.tryPromise({
    try: () =>
      chromium.launchPersistentContext(userDataDir, {
        headless: process.env.SCENARIO_BROWSER_HEADLESS !== '0',
      }),
    catch: (cause) => browserError(`Failed to launch Chromium: ${String(cause)}`),
  })

const setContextOffline = (context: BrowserContext, offline: boolean) =>
  Effect.tryPromise({
    try: () => context.setOffline(offline),
    catch: (cause) => browserError(`Failed to set browser offline=${offline}: ${String(cause)}`),
  })

const shutdownPage = (page: Page) =>
  Effect.tryPromise({
    try: async () => {
      if (page.isClosed() === true) return
      await page.evaluate(() => window.__scenarioBrowser.shutdown()).catch(() => undefined)
      await page.close()
    },
    catch: (cause) => browserError(`Failed to close browser session: ${String(cause)}`),
  })

const closePages = (pages: Map<string, Page>) =>
  Effect.forEach([...pages.values()], shutdownPage, { discard: true, concurrency: 'unbounded' }).pipe(
    Effect.tap(() => Effect.sync(() => pages.clear())),
  )

const closeContext = (context: BrowserContext) =>
  Effect.tryPromise({
    try: () => context.close(),
    catch: (cause) => browserError(`Failed to close browser Client: ${String(cause)}`),
  })

const observePage = (page: Page): Effect.Effect<BrowserPageObservation, ScenarioOperationError> =>
  Effect.tryPromise({
    try: () => page.evaluate(() => window.__scenarioBrowser.observe()),
    catch: (cause) => browserError(`Browser observation failed: ${String(cause)}`),
  })

const dispatchPageAction = (
  page: Page,
  input: Parameters<Window['__scenarioBrowser']['dispatchAction']>[0],
): Effect.Effect<void, ScenarioOperationError> =>
  Effect.tryPromise({
    try: () => page.evaluate((args) => window.__scenarioBrowser.dispatchAction(args), input),
    catch: (cause) => browserError(`Browser action failed: ${String(cause)}`),
  })

const inspectPageState = (page: Page, input: Parameters<Window['__scenarioBrowser']['inspectState']>[0]) =>
  Effect.tryPromise({
    try: () => page.evaluate((args) => window.__scenarioBrowser.inspectState(args), input),
    catch: (cause) => browserError(`Browser state inspection failed: ${String(cause)}`),
  })

const startFixtureServer = (args: {
  backendUrl: string
  storeIdSuffix: string
}): Effect.Effect<{ baseUrl: string; server: ViteDevServer }, ScenarioOperationError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const server = await createServer({
          root: path.join(import.meta.dirname, 'fixture'),
          logLevel: 'error',
          server: { host: '127.0.0.1', port: 0 },
          define: {
            __SCENARIO_SYNC_URL__: jsonStringify(args.backendUrl),
            __SCENARIO_STORE_SUFFIX__: jsonStringify(args.storeIdSuffix),
          },
        })
        await server.listen()
        const address = server.httpServer?.address()
        if (address === null || address === undefined || typeof address === 'string') {
          await server.close()
          throw new Error('Vite did not expose a TCP port')
        }
        return { baseUrl: `http://127.0.0.1:${address.port}`, server }
      },
      catch: (cause) => browserError(`Failed to start browser fixture: ${String(cause)}`),
    }),
    ({ server }) =>
      Effect.tryPromise({
        try: () => server.close(),
        catch: (cause) => browserError(`Failed to close browser fixture: ${String(cause)}`),
      }).pipe(Effect.ignore),
  )

const getClient = (
  clients: ReadonlyMap<string, BrowserClientController>,
  clientId: string,
): Effect.Effect<BrowserClientController, ScenarioOperationError> => {
  const client = clients.get(clientId)
  return client === undefined
    ? Effect.fail(new ScenarioOperationError('missing-client', `Client ${clientId} does not exist`))
    : Effect.succeed(client)
}

const reconcileClientObservation =
  (eventRefs: ReturnType<typeof makeEventRefRegistry>) =>
  (client: ClientSystemObservation): ClientSystemObservation => ({
    ...client,
    leader: { ...client.leader, events: eventRefs.reconcileObservedEvents(client.leader.events) },
    sessions: client.sessions.map((session) => ({
      ...session,
      sync: { ...session.sync, events: eventRefs.reconcileObservedEvents(session.sync.events) },
    })),
  })

const hydrateConfirmedEvents = (
  client: ClientSystemObservation,
  backendEvents: ReadonlyArray<LiveStoreEvent.Global.Encoded>,
  eventRefs: ReturnType<typeof makeEventRefRegistry>,
): ClientSystemObservation => {
  const confirmedThrough = (head: string) => {
    const globalHead = EventSequenceNumber.Client.fromString(head).global
    return eventRefs.observeGlobalEvents(backendEvents.filter((event) => event.seqNum <= globalHead))
  }

  return {
    ...client,
    leader: {
      ...client.leader,
      events: [...confirmedThrough(client.leader.upstreamHead), ...client.leader.events],
    },
    sessions: client.sessions.map((session) => ({
      ...session,
      sync: {
        ...session.sync,
        events: [...confirmedThrough(session.sync.upstreamHead), ...session.sync.events],
      },
    })),
  }
}

const deriveLeaderObservation = (client: ClientSystemObservation, backendHead: number): ClientSystemObservation => {
  const localHead = EventSequenceNumber.Client.fromString(client.leader.upstreamHead)
  return {
    ...client,
    leader: {
      ...client.leader,
      localHead: client.leader.upstreamHead,
      upstreamHead: `e${backendHead}`,
      pendingCount: Math.max(client.leader.pendingCount, localHead.client),
    },
  }
}

const jsonStringify = Schema.encodeSync(Schema.UnknownFromJsonString)

const acknowledge = (operationId: string): HostAcknowledgement => ({ operationId, status: 'acknowledged' })

const browserError = (message: string) => new ScenarioOperationError('capability-unavailable', message)
