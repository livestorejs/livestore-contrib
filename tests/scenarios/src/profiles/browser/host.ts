import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from 'vite'

import { EventSequenceNumber } from '@livestore/common/schema'
import { Effect, Schema, type Scope } from '@livestore/utils/effect'

import {
  participantHostFailure,
  ScenarioOperationError,
  type ScenarioOperationFailureOutcome,
} from '../../application/definition.ts'
import type { ScenarioBackend } from '../../backends.ts'
import { calibrateParticipantReading, makeParticipantClock, readControllerOccurrence } from '../../clock.ts'
import { getScenarioApplication } from '../../corpus/applications/registry.ts'
import {
  type ClientSystemObservation,
  ClientSystemObservation as ClientSystemObservationSchema,
  type HostAcknowledgement,
  type HostCapabilities,
  type HostObservationOccurrence,
  HostSystemObservation as HostSystemObservationSchema,
  type ParticipantRef,
  type RuntimeFailureObservation,
  SyncObservation as SyncObservationSchema,
} from '../../model.ts'
import { makeEventRefRegistry } from '../../observations.ts'
import type { ParticipantHost } from '../contract.ts'
import type { BrowserPageObservation, BrowserStartOptions } from './protocol.ts'

export const browserHostCapabilities: HostCapabilities = {
  profile: 'browser',
  capabilities: [
    'multiple-clients',
    'multiple-sessions',
    'named-actions',
    'disconnect-reconnect',
    'backend-availability',
    'sync-observation',
    'system-observation',
    'state-inspection',
    'opfs-state',
    'session-restart',
    'client-restart',
    'dynamic-client-creation',
    'dynamic-session-addition',
    'browser-shared-worker',
    'browser-web-locks',
  ],
  maximumSessionsPerClient: 8,
  settlement: 'stable-poll',
}

export interface BrowserParticipantHost extends ParticipantHost {
  /** Test-only resource identities used to prove scope cleanup. */
  readonly profileDirectories: () => ReadonlyArray<string>
}

export const makeBrowserHost = (args: {
  applicationId: string
  backend: Pick<ScenarioBackend, 'id' | 'observe' | 'setAvailability' | 'serializedConfig' | 'componentVersions'>
}): Effect.Effect<BrowserParticipantHost, ScenarioOperationError, Scope.Scope> =>
  Effect.gen(function* () {
    try {
      getScenarioApplication(args.applicationId)
    } catch {
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
    const observationClock = makeParticipantClock('browser-host')
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
          applicationId: args.applicationId,
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

    const addSession: ParticipantHost['addSession'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.target.clientId)
        yield* client.addSession(command.target.sessionId)
        return acknowledge(command.operationId)
      })

    const setConnectivity: ParticipantHost['setConnectivity'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.clientId)
        yield* client.setConnectivity(command.connected)
        return acknowledge(command.operationId)
      })

    const setBackendAvailability: ParticipantHost['setBackendAvailability'] = (command) =>
      args.backend.setAvailability(command.available).pipe(Effect.as(acknowledge(command.operationId)))

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
      const observedClients = yield* Effect.forEach(
        [...clients.values()],
        (client) =>
          client.observe.pipe(
            Effect.tap((observed) =>
              Effect.sync(() => {
                if (process.env.SCENARIO_BROWSER_DIAGNOSTICS === '1') {
                  const sync = observed.observation.sessions[0]?.sync
                  console.log(
                    `  browser observation completed: ${client.clientId} · local ${sync?.localHead ?? '?'} · upstream ${sync?.upstreamHead ?? '?'} · ${sync?.pendingCount ?? '?'} pending`,
                  )
                }
              }),
            ),
            Effect.map((observed) => ({
              ...observed,
              observation: reconcileClientObservation(eventRefs)(observed.observation),
            })),
          ),
        { concurrency: 'unbounded' },
      )
      return yield* Schema.decodeUnknownEffect(HostSystemObservationSchema)({
        backend: {
          id: 'sync-backend',
          connected: backend.connected,
          head: `e${backendHead}`,
          events: eventRefs.observeGlobalEvents(backend.events),
        },
        clients: observedClients.map(({ observation }) => observation),
        occurrences: {
          backend: readControllerOccurrence(observationClock),
          clients: observedClients.map((observed) => ({
            clientId: observed.observation.clientId,
            connectivity: observed.connectivityOccurrence,
            leader: observed.leaderOccurrence,
            sessions: observed.sessions,
          })),
        },
      }).pipe(
        Effect.mapError((cause) => browserResponseInvalid(`Invalid browser system observation: ${String(cause)}`)),
      )
    })

    const observeSync: ParticipantHost['observeSync'] = (participant) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, participant.clientId)
        const page = yield* client.getSession(participant.sessionId)
        const observation = yield* observePage(page)
        if (observedStoreId === undefined)
          return yield* Effect.fail(browserRequestRejected('Browser store is not initialized'))
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
        }).pipe(
          Effect.mapError((cause) => browserResponseInvalid(`Invalid browser sync observation: ${String(cause)}`)),
        )
      })

    const drainRuntimeFailures: ParticipantHost['drainRuntimeFailures'] = Effect.sync(() =>
      [...clients.values()].flatMap((client) => client.drainRuntimeFailures()),
    )

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
      addSession,
      dispatchAction,
      setConnectivity,
      setBackendAvailability,
      stopSession,
      restartSession,
      restartClient,
      observeSystem,
      drainRuntimeFailures,
      observeSync,
      inspectState,
      profileDirectories: () => [...clients.values()].map((client) => client.userDataDir),
    }
  })

interface BrowserClientController {
  readonly clientId: string
  readonly userDataDir: string
  readonly connected: () => boolean
  readonly getSession: (sessionId: string) => Effect.Effect<Page, ScenarioOperationError>
  readonly addSession: (sessionId: string) => Effect.Effect<void, ScenarioOperationError>
  readonly setConnectivity: (connected: boolean) => Effect.Effect<void, ScenarioOperationError>
  readonly stopSession: (sessionId: string) => Effect.Effect<void, ScenarioOperationError>
  readonly restartSession: (sessionId: string) => Effect.Effect<void, ScenarioOperationError>
  readonly restart: Effect.Effect<void, ScenarioOperationError>
  readonly observe: Effect.Effect<BrowserClientObservation, ScenarioOperationError>
  readonly drainRuntimeFailures: () => ReadonlyArray<RuntimeFailureObservation>
  readonly shutdown: Effect.Effect<void, ScenarioOperationError>
}

interface BrowserClientObservation {
  readonly observation: ClientSystemObservation
  readonly connectivityOccurrence: HostObservationOccurrence
  readonly leaderOccurrence: HostObservationOccurrence
  readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly occurrence: HostObservationOccurrence }>
}

const makeBrowserClient = (args: {
  applicationId: string
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
        catch: (cause) => browserInfrastructureFailure(`Failed to create browser profile: ${String(cause)}`),
      })
      const state = {
        context: yield* launchBrowserContext(userDataDir),
        connected: args.initiallyConnected,
        pages: new Map<string, Page>(),
        runtimeFailures: [] as RuntimeFailureObservation[],
      }
      const knownSessionIds = new Set(args.sessionIds)
      let shutdownComplete = false

      for (const sessionId of args.sessionIds) {
        const page = yield* startSessionPage({
          ...args,
          context: state.context,
          sessionId,
          onRuntimeFailure: (failure) => state.runtimeFailures.push(failure),
        })
        state.pages.set(sessionId, page)
      }
      if (state.connected === false) yield* setClientSyncConnectivity(state.pages, false)

      const getSession = (sessionId: string): Effect.Effect<Page, ScenarioOperationError> => {
        const page = state.pages.get(sessionId)
        return page === undefined
          ? Effect.fail(browserRequestRejected(`Session ${args.clientId}/${sessionId} is not running`))
          : Effect.succeed(page)
      }

      const stopSession = (sessionId: string) =>
        Effect.gen(function* () {
          const page = yield* getSession(sessionId)
          yield* shutdownPage(page)
          state.pages.delete(sessionId)
        })

      const addSession = (sessionId: string) =>
        Effect.gen(function* () {
          if (knownSessionIds.has(sessionId) === true) {
            return yield* Effect.fail(browserRequestRejected(`Session ${args.clientId}/${sessionId} already exists`))
          }
          if (knownSessionIds.size >= browserHostCapabilities.maximumSessionsPerClient) {
            return yield* Effect.fail(
              browserRequestRejected(
                `Client ${args.clientId} already has the maximum ${browserHostCapabilities.maximumSessionsPerClient} sessions`,
              ),
            )
          }
          const page = yield* startSessionPage({
            ...args,
            context: state.context,
            sessionId,
            onRuntimeFailure: (failure) => state.runtimeFailures.push(failure),
          })
          if (state.connected === false) yield* setClientSyncConnectivity(new Map([[sessionId, page]]), false)
          knownSessionIds.add(sessionId)
          state.pages.set(sessionId, page)
        })

      const restartSession = (sessionId: string) =>
        Effect.gen(function* () {
          if (knownSessionIds.has(sessionId) === false) {
            return yield* Effect.fail(browserRequestRejected(`Unknown session ${args.clientId}/${sessionId}`))
          }
          if (state.pages.has(sessionId) === true) {
            return yield* Effect.fail(
              browserRequestRejected(`Session ${args.clientId}/${sessionId} is already running`),
            )
          }
          const page = yield* startSessionPage({
            ...args,
            context: state.context,
            sessionId,
            onRuntimeFailure: (failure) => state.runtimeFailures.push(failure),
          })
          state.pages.set(sessionId, page)
        })

      const setConnectivity = (connected: boolean) =>
        Effect.gen(function* () {
          if (connected === true && process.env.SCENARIO_BROWSER_DB_SNAPSHOT_DIR !== undefined) {
            yield* persistPageDiagnostics({
              pages: state.pages,
              clientId: args.clientId,
              directory: process.env.SCENARIO_BROWSER_DB_SNAPSHOT_DIR,
            })
          }
          yield* setClientSyncConnectivity(state.pages, connected)
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              state.connected = connected
              if (process.env.SCENARIO_BROWSER_DIAGNOSTICS === '1') {
                console.log(`  browser context ${args.clientId}: ${connected === true ? 'online' : 'offline'}`)
              }
            }),
          ),
        )

      const restart = Effect.gen(function* () {
        yield* closePages(state.pages)
        yield* closeContext(state.context)
        state.context = yield* launchBrowserContext(userDataDir)
        for (const sessionId of knownSessionIds) {
          const page = yield* startSessionPage({
            ...args,
            context: state.context,
            sessionId,
            onRuntimeFailure: (failure) => state.runtimeFailures.push(failure),
          })
          state.pages.set(sessionId, page)
        }
        if (state.connected === false) yield* setClientSyncConnectivity(state.pages, false)
      })

      const observe = Effect.gen(function* () {
        if (process.env.SCENARIO_BROWSER_DIAGNOSTICS === '1') {
          console.log(`  browser observation started: ${args.clientId}`)
        }
        const observations = yield* Effect.forEach(
          [...state.pages.entries()],
          ([sessionId, page]) =>
            observePageWithTiming(page).pipe(Effect.map((observed) => ({ sessionId, ...observed }))),
          { concurrency: 'unbounded' },
        )
        const leader = observations[0]?.observation.leader
        const leaderOccurrence = observations[0]?.occurrence
        if (leader === undefined)
          return yield* Effect.fail(browserRequestRejected(`Client ${args.clientId} has no running session`))
        if (leaderOccurrence === undefined)
          return yield* Effect.fail(
            browserResponseInvalid(`Client ${args.clientId} observation has no timing evidence`),
          )
        const observation = yield* Schema.decodeUnknownEffect(ClientSystemObservationSchema)({
          clientId: args.clientId,
          connected: state.connected,
          leader,
          sessions: observations.map(({ sessionId, observation }) => ({ sessionId, sync: observation.session })),
        }).pipe(Effect.mapError((cause) => browserResponseInvalid(`Invalid Client observation: ${String(cause)}`)))
        return {
          observation,
          connectivityOccurrence: leaderOccurrence,
          leaderOccurrence,
          sessions: observations.map(({ sessionId, occurrence }) => ({ sessionId, occurrence })),
        }
      })

      const shutdown = Effect.gen(function* () {
        if (shutdownComplete === true) return
        shutdownComplete = true
        yield* closePages(state.pages)
        yield* closeContext(state.context)
        yield* Effect.tryPromise({
          try: () => fs.rm(userDataDir, { recursive: true, force: true }),
          catch: (cause) =>
            browserInfrastructureFailure(`Failed to remove browser profile ${userDataDir}: ${String(cause)}`),
        })
      })

      return {
        clientId: args.clientId,
        userDataDir,
        connected: () => state.connected,
        getSession,
        addSession,
        setConnectivity,
        stopSession,
        restartSession,
        restart,
        observe,
        drainRuntimeFailures: () => state.runtimeFailures.splice(0),
        shutdown,
      }
    }),
    (controller) => controller.shutdown.pipe(Effect.ignore),
  )

const startSessionPage = (args: {
  context: BrowserContext
  applicationId: string
  baseUrl: string
  storeId: string
  clientId: string
  sessionId: string
  onRuntimeFailure: (failure: RuntimeFailureObservation) => void
}): Effect.Effect<Page, ScenarioOperationError> =>
  Effect.gen(function* () {
    const page = yield* Effect.tryPromise({
      try: async () => {
        const page = await args.context.newPage()
        page.on('console', (message) => {
          const text = message.text()
          if (message.type() === 'error') console.error(`[browser ${args.clientId}/${args.sessionId}] ${text}`)
          else if (process.env.SCENARIO_BROWSER_DIAGNOSTICS === '1')
            console.log(`[browser ${args.clientId}/${args.sessionId}:${message.type()}] ${text}`)
          if (message.type() === 'error' || /\bERROR \(#\d+\):/.test(text) === true) {
            args.onRuntimeFailure({
              clientId: args.clientId,
              sessionId: args.sessionId,
              source: 'browser-console',
              code: 'browser-console-error',
              message: text,
            })
          }
        })
        page.on('pageerror', (error) => {
          console.error(`[browser ${args.clientId}/${args.sessionId}]`, error)
          args.onRuntimeFailure({
            clientId: args.clientId,
            sessionId: args.sessionId,
            source: 'browser-page',
            code: 'browser-page-error',
            message: error.stack ?? error.message,
          })
        })
        await page.goto(args.baseUrl)
        await page.waitForFunction(() => window.__scenarioBrowser !== undefined)
        return page
      },
      catch: (cause) =>
        browserInfrastructureFailure(`Failed to start ${args.clientId}/${args.sessionId}: ${String(cause)}`),
    })
    const options: BrowserStartOptions = {
      applicationId: args.applicationId,
      storeId: args.storeId,
      clientId: args.clientId,
      sessionId: args.sessionId,
    }
    yield* Effect.tryPromise({
      try: () => page.evaluate((input) => window.__scenarioBrowser.start(input), options),
      catch: (cause) =>
        browserTransportFailure(
          `Browser start completion was not observed for ${args.clientId}/${args.sessionId}: ${String(cause)}`,
          'indefinite',
        ),
    })
    return page
  })

const launchBrowserContext = (userDataDir: string): Effect.Effect<BrowserContext, ScenarioOperationError> =>
  Effect.tryPromise({
    try: () =>
      chromium.launchPersistentContext(userDataDir, {
        headless: process.env.SCENARIO_BROWSER_HEADLESS !== '0',
      }),
    catch: (cause) => browserInfrastructureFailure(`Failed to launch Chromium: ${String(cause)}`),
  })

const setClientSyncConnectivity = (pages: ReadonlyMap<string, Page>, connected: boolean) =>
  Effect.gen(function* () {
    const page = pages.values().next().value
    if (page === undefined)
      return yield* Effect.fail(browserRequestRejected('Client has no running session to control its sync latch'))
    yield* Effect.tryPromise({
      try: () => page.evaluate((value) => window.__scenarioBrowser.setConnectivity(value), connected),
      catch: (cause) =>
        browserTransportFailure(`Failed to confirm browser connected=${connected}: ${String(cause)}`, 'indefinite'),
    })
  })

const persistPageDiagnostics = (args: { pages: ReadonlyMap<string, Page>; clientId: string; directory: string }) =>
  Effect.gen(function* () {
    const [sessionId, page] = args.pages.entries().next().value ?? []
    if (sessionId === undefined || page === undefined)
      return yield* Effect.fail(browserRequestRejected('Client has no running session to inspect'))
    const diagnostics = yield* Effect.tryPromise({
      try: () => page.evaluate(() => window.__scenarioBrowser.captureDatabaseDiagnostics()),
      catch: (cause) =>
        browserTransportFailure(`Failed to capture browser database diagnostics: ${String(cause)}`, 'definite-failure'),
    })
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(args.directory, { recursive: true })
        const prefix = path.join(args.directory, `${args.clientId}-${sessionId}-before-reconnect`)
        await Promise.all([
          fs.writeFile(`${prefix}-session.db`, Buffer.from(diagnostics.sessionStateBase64, 'base64')),
          fs.writeFile(`${prefix}-leader.db`, Buffer.from(diagnostics.leaderStateBase64, 'base64')),
          fs.writeFile(`${prefix}-eventlog.db`, Buffer.from(diagnostics.eventlogBase64, 'base64')),
          fs.writeFile(`${prefix}-sync-states.json`, `${jsonStringify(diagnostics.syncStates)}\n`, 'utf8'),
        ])
      },
      catch: (cause) =>
        browserInfrastructureFailure(`Failed to persist browser database diagnostics: ${String(cause)}`),
    })
  })

const shutdownPage = (page: Page) =>
  Effect.tryPromise({
    try: async () => {
      if (page.isClosed() === true) return
      await page.evaluate(() => window.__scenarioBrowser.shutdown()).catch(() => undefined)
      await page.close()
    },
    catch: (cause) => browserInfrastructureFailure(`Failed to close browser session: ${String(cause)}`, 'indefinite'),
  })

const closePages = (pages: Map<string, Page>) =>
  Effect.forEach([...pages.values()], shutdownPage, { discard: true, concurrency: 'unbounded' }).pipe(
    Effect.tap(() => Effect.sync(() => pages.clear())),
  )

const closeContext = (context: BrowserContext) =>
  Effect.tryPromise({
    try: () => context.close(),
    catch: (cause) => browserInfrastructureFailure(`Failed to close browser Client: ${String(cause)}`, 'indefinite'),
  })

const observePage = (page: Page): Effect.Effect<BrowserPageObservation, ScenarioOperationError> =>
  observePageWithTiming(page).pipe(Effect.map(({ observation }) => observation))

const observePageWithTiming = (
  page: Page,
): Effect.Effect<
  { readonly observation: BrowserPageObservation; readonly occurrence: HostObservationOccurrence },
  ScenarioOperationError
> => {
  const controllerBeforeMonotonicMs = performance.now()
  return Effect.tryPromise({
    try: () => page.evaluate(() => window.__scenarioBrowser.observe()),
    catch: (cause) => browserTransportFailure(`Browser observation failed: ${String(cause)}`, 'definite-failure'),
  }).pipe(
    Effect.map((observation) => ({
      observation,
      occurrence: calibrateParticipantReading({
        reading: observation.clock,
        controllerBeforeMonotonicMs,
        controllerAfterMonotonicMs: performance.now(),
        calibrationId: `${observation.clock.emitterId}:${observation.clock.localSequence}`,
      }),
    })),
  )
}

const dispatchPageAction = (
  page: Page,
  input: Parameters<Window['__scenarioBrowser']['dispatchAction']>[0],
): Effect.Effect<void, ScenarioOperationError> =>
  Effect.tryPromise({
    try: () => page.evaluate((args) => window.__scenarioBrowser.dispatchAction(args), input),
    catch: (cause) =>
      browserTransportFailure(`Browser action completion was not observed: ${String(cause)}`, 'indefinite'),
  })

const inspectPageState = (page: Page, input: Parameters<Window['__scenarioBrowser']['inspectState']>[0]) =>
  Effect.tryPromise({
    try: () => page.evaluate((args) => window.__scenarioBrowser.inspectState(args), input),
    catch: (cause) => browserTransportFailure(`Browser state inspection failed: ${String(cause)}`, 'definite-failure'),
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
          server: {
            host: '127.0.0.1',
            port: 0,
            fs: {
              allow: [
                searchForWorkspaceRoot(import.meta.dirname),
                ...(process.env.LIVESTORE_SCENARIO_CORE_PATH === undefined
                  ? []
                  : [process.env.LIVESTORE_SCENARIO_CORE_PATH]),
              ],
            },
          },
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
      catch: (cause) => browserInfrastructureFailure(`Failed to start browser fixture: ${String(cause)}`),
    }),
    ({ server }) =>
      Effect.tryPromise({
        try: () => server.close(),
        catch: (cause) => browserInfrastructureFailure(`Failed to close browser fixture: ${String(cause)}`),
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

const jsonStringify = Schema.encodeSync(Schema.UnknownFromJsonString)

const acknowledge = (operationId: string): HostAcknowledgement => ({ operationId, status: 'acknowledged' })

const browserInfrastructureFailure = (
  message: string,
  operationOutcome: ScenarioOperationFailureOutcome = 'definite-failure',
) => participantHostFailure({ code: 'host-infrastructure-failure', message, operationOutcome })

const browserRequestRejected = (message: string) =>
  participantHostFailure({ code: 'host-request-rejected', message, operationOutcome: 'definite-failure' })

const browserResponseInvalid = (message: string) =>
  participantHostFailure({ code: 'host-response-invalid', message, operationOutcome: 'definite-failure' })

const browserTransportFailure = (message: string, operationOutcome: ScenarioOperationFailureOutcome) =>
  participantHostFailure({ code: 'host-transport-failure', message, operationOutcome })
