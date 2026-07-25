import { fork as forkProcess, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Effect, Exit, Schema, type Scope } from '@livestore/utils/effect'

import {
  participantHostFailure,
  ScenarioOperationError,
  type ParticipantHostFailureCode,
  type ScenarioOperationFailureOutcome,
} from '../application.ts'
import type { ScenarioBackend } from '../backends.ts'
import { calibrateParticipantReading, makeParticipantClock, readControllerOccurrence } from '../clock.ts'
import type { ParticipantHost } from '../host.ts'
import type {
  ClientSystemObservation,
  HostAcknowledgement,
  HostCapabilities,
  HostObservationOccurrence,
  ParticipantRef,
} from '../model.ts'
import {
  ClientSystemObservation as ClientSystemObservationSchema,
  SyncObservation as SyncObservationSchema,
} from '../model.ts'
import { makeEventRefRegistry } from '../observations.ts'
import type {
  ProcessClientCommand,
  ProcessClientRequest,
  ProcessClientResponse,
  ProcessClientResult,
} from './protocol.ts'

export const processHostCapabilities: HostCapabilities = {
  profile: 'process',
  capabilities: [
    'multiple-clients',
    'named-actions',
    'disconnect-reconnect',
    'sync-observation',
    'system-observation',
    'state-inspection',
    'sqlite-state',
    'process-isolation',
  ],
  maximumSessionsPerClient: 1,
  settlement: 'stable-poll',
}

export interface ProcessParticipantHost extends ParticipantHost {
  readonly processIds: () => ReadonlyArray<number>
}

export const makeProcessHost = (args: {
  applicationId: string
  backend: Pick<ScenarioBackend, 'id' | 'observe' | 'serializedConfig' | 'componentVersions'>
}): Effect.Effect<ProcessParticipantHost, ScenarioOperationError, Scope.Scope> =>
  Effect.gen(function* () {
    if (args.backend.serializedConfig._tag !== 'sync-cf-ws') {
      return yield* Effect.fail(
        new ScenarioOperationError('capability-unavailable', 'Process profile currently requires local sync-cf'),
      )
    }

    const clients = new Map<string, ProcessClientController>()
    const eventRefs = makeEventRefRegistry()
    const observationClock = makeParticipantClock('process-host')
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
        if (command.client.sessions.length !== 1) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'capability-unavailable',
              `Process profile supports exactly one session per Client; ${command.client.id} requested ${command.client.sessions.length}`,
            ),
          )
        }

        const controller = yield* spawnProcessClient(command.client.id)
        yield* controller.request({
          _tag: 'initialize',
          applicationId: args.applicationId,
          storeId: command.storeId,
          client: command.client,
          backend: args.backend.serializedConfig,
        })
        clients.set(command.client.id, controller)
        observedStoreId ??= command.storeId
        return acknowledge(command.operationId)
      })

    const dispatchAction: ParticipantHost['dispatchAction'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.target.clientId)
        yield* client.request({
          _tag: 'dispatch-action',
          target: command.target,
          action: command.action,
          input: command.input,
        })
        return acknowledge(command.operationId)
      })

    const setConnectivity: ParticipantHost['setConnectivity'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.clientId)
        yield* client.request({ _tag: 'set-connectivity', connected: command.connected })
        return acknowledge(command.operationId)
      })

    const observeSystem: ParticipantHost['observeSystem'] = Effect.gen(function* () {
      const backend =
        observedStoreId === undefined ? { connected: true, events: [] } : yield* args.backend.observe(observedStoreId)
      const observedClients = yield* Effect.forEach(
        [...clients.values()],
        (client) =>
          client.requestWithTiming({ _tag: 'observe-client' }).pipe(
            Effect.flatMap(({ result, occurrence }) =>
              expectResult('client-observation')(result).pipe(
                Effect.flatMap((observationResult) => decodeClientObservation(observationResult.observation)),
                Effect.map(reconcileClientObservation(eventRefs)),
                Effect.map((observation) => ({ observation, occurrence })),
              ),
            ),
          ),
        { concurrency: 'unbounded' },
      )

      return {
        backend: {
          id: 'sync-backend',
          connected: backend.connected,
          head: `e${backend.events.at(-1)?.seqNum ?? 0}`,
          events: eventRefs.observeGlobalEvents(backend.events),
        },
        clients: observedClients.map(({ observation }) => observation),
        occurrences: {
          backend: readControllerOccurrence(observationClock),
          clients: observedClients.map(({ observation, occurrence }) => ({
            clientId: observation.clientId,
            connectivity: occurrence,
            leader: occurrence,
            sessions: observation.sessions.map((session) => ({ sessionId: session.sessionId, occurrence })),
          })),
        },
      }
    })

    const observeSync: ParticipantHost['observeSync'] = (participant) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, participant.clientId)
        const result = yield* client
          .request({ _tag: 'observe-sync', participant })
          .pipe(Effect.flatMap(expectResult('sync-observation')))
        return yield* Schema.decodeUnknownEffect(SyncObservationSchema)(result.observation).pipe(
          Effect.mapError((cause) => processResponseInvalid(`Invalid sync observation: ${String(cause)}`)),
        )
      })

    const inspectState: ParticipantHost['inspectState'] = (command) =>
      Effect.gen(function* () {
        const client = yield* getClient(clients, command.target.clientId)
        const result = yield* client
          .request({ _tag: 'inspect-state', participant: command.target, inspector: command.inspector })
          .pipe(Effect.flatMap(expectResult('state')))
        return result.value
      })

    return {
      capabilities: processHostCapabilities,
      backendId: args.backend.id,
      componentVersions: {
        '@livestore/livestore': 'workspace',
        ...args.backend.componentVersions,
        node: process.version,
      },
      createClient,
      dispatchAction,
      setConnectivity,
      stopSession: unsupportedLifecycle('session stop'),
      restartSession: unsupportedLifecycle('session restart'),
      restartClient: unsupportedLifecycle('Client restart'),
      observeSystem,
      drainRuntimeFailures: Effect.succeed([]),
      observeSync,
      inspectState,
      processIds: () => [...clients.values()].map((client) => client.pid),
    }
  })

interface ProcessClientController {
  readonly clientId: string
  readonly pid: number
  readonly request: (command: ProcessClientCommand) => Effect.Effect<ProcessClientResult, ScenarioOperationError>
  readonly requestWithTiming: (
    command: ProcessClientCommand,
  ) => Effect.Effect<
    { readonly result: ProcessClientResult; readonly occurrence: HostObservationOccurrence },
    ScenarioOperationError
  >
  readonly shutdown: Effect.Effect<void, ScenarioOperationError>
}

const spawnProcessClient = (
  clientId: string,
): Effect.Effect<ProcessClientController, ScenarioOperationError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const child = forkProcess(processClientEntry(), [], {
          execArgv: ['--import', import.meta.resolve('tsx'), '--enable-source-maps'],
          serialization: 'advanced',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        await waitForSpawn(child)
        return makeController(clientId, child)
      },
      catch: (cause) => processInfrastructureFailure(`Failed to spawn Client ${clientId}: ${String(cause)}`),
    }),
    (controller) => controller.shutdown.pipe(Effect.ignore),
  )

const makeController = (clientId: string, child: ChildProcess): ProcessClientController => {
  let nextRequest = 1
  const pending = new Map<
    string,
    {
      resolve: (result: ProcessClientResult) => void
      reject: (cause: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  let stderr = ''

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  child.on('message', (message: ProcessClientResponse) => {
    const waiter = pending.get(message.requestId)
    if (waiter === undefined) return
    clearTimeout(waiter.timeout)
    pending.delete(message.requestId)
    if (message.status === 'success') waiter.resolve(message.result)
    else waiter.reject(new ProcessRequestFailure('host-request-rejected', 'definite-failure', message.error))
  })
  child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(
        new ProcessRequestFailure(
          'host-transport-failure',
          'indefinite',
          `Client ${clientId} exited (${code ?? signal ?? 'unknown'})\n${stderr}`,
        ),
      )
    }
    pending.clear()
  })

  const requestWithTiming = (
    command: ProcessClientCommand,
  ): Effect.Effect<
    { readonly result: ProcessClientResult; readonly occurrence: HostObservationOccurrence },
    ScenarioOperationError
  > => {
    const controllerBeforeMonotonicMs = performance.now()
    return Effect.tryPromise({
      try: () =>
        new Promise<ProcessClientResult>((resolve, reject) => {
          if (child.connected !== true) {
            reject(
              new ProcessRequestFailure(
                'host-transport-failure',
                'definite-failure',
                `Client ${clientId} IPC channel is closed`,
              ),
            )
            return
          }
          const requestId = `${clientId}:${nextRequest}`
          nextRequest += 1
          const timeout = setTimeout(() => {
            pending.delete(requestId)
            reject(
              new ProcessRequestFailure(
                'host-response-timeout',
                'indefinite',
                `Client ${clientId} timed out handling ${command._tag}\n${stderr}`,
              ),
            )
          }, 20_000)
          pending.set(requestId, { resolve, reject, timeout })
          const message: ProcessClientRequest = { requestId, command }
          child.send(message)
        }),
      catch: (cause) => processRequestError(clientId, command._tag, cause),
    }).pipe(
      Effect.map((result) => ({
        result,
        occurrence: calibrateParticipantReading({
          reading: result.clock,
          controllerBeforeMonotonicMs,
          controllerAfterMonotonicMs: performance.now(),
          calibrationId: `${clientId}:${result.clock.localSequence}`,
        }),
      })),
    )
  }

  const request = (command: ProcessClientCommand): Effect.Effect<ProcessClientResult, ScenarioOperationError> =>
    requestWithTiming(command).pipe(Effect.map(({ result }) => result))

  const shutdown = Effect.gen(function* () {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.connected === true) {
      yield* request({ _tag: 'shutdown' }).pipe(Effect.timeout('5 seconds'), Effect.ignore)
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    yield* waitForExit(child).pipe(Effect.timeout('5 seconds'), Effect.ignore)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })

  return { clientId, pid: child.pid!, request, requestWithTiming, shutdown }
}

const waitForSpawn = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    if (child.pid !== undefined) {
      resolve()
      return
    }
    child.once('spawn', resolve)
    child.once('error', reject)
  })

const waitForExit = (child: ChildProcess): Effect.Effect<void, ScenarioOperationError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve()
        else child.once('exit', () => resolve())
      }),
    catch: (cause) => processInfrastructureFailure(`Failed while waiting for process exit: ${String(cause)}`),
  })

const processClientEntry = (): string => {
  const extension = import.meta.url.endsWith('.ts') === true ? 'ts' : 'js'
  return fileURLToPath(new URL(`./process-client.${extension}`, import.meta.url))
}

const getClient = (
  clients: ReadonlyMap<string, ProcessClientController>,
  clientId: string,
): Effect.Effect<ProcessClientController, ScenarioOperationError> => {
  const client = clients.get(clientId)
  return client === undefined
    ? Effect.fail(new ScenarioOperationError('missing-client', `Client ${clientId} does not exist`))
    : Effect.succeed(client)
}

const expectResult =
  <TTag extends ProcessClientResult['_tag']>(tag: TTag) =>
  (result: ProcessClientResult): Effect.Effect<Extract<ProcessClientResult, { _tag: TTag }>, ScenarioOperationError> =>
    result._tag === tag
      ? Effect.succeed(result as Extract<ProcessClientResult, { _tag: TTag }>)
      : Effect.fail(processResponseInvalid(`Expected ${tag} response, received ${result._tag}`))

const decodeClientObservation = (input: unknown) =>
  Schema.decodeUnknownEffect(ClientSystemObservationSchema)(input).pipe(
    Effect.mapError((cause) => processResponseInvalid(`Invalid Client observation: ${String(cause)}`)),
  )

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

const acknowledge = (operationId: string): HostAcknowledgement => ({ operationId, status: 'acknowledged' })

class ProcessRequestFailure extends Error {
  constructor(
    readonly code: ParticipantHostFailureCode,
    readonly operationOutcome: ScenarioOperationFailureOutcome,
    message: string,
  ) {
    super(message)
    this.name = 'ProcessRequestFailure'
  }
}

const processRequestError = (clientId: string, operation: string, cause: unknown): ScenarioOperationError => {
  const classification =
    cause instanceof ProcessRequestFailure
      ? cause
      : new ProcessRequestFailure(
          'host-transport-failure',
          'indefinite',
          `Unexpected process request failure: ${String(cause)}`,
        )
  return participantHostFailure({
    code: classification.code,
    operationOutcome: classification.operationOutcome,
    message: `Client ${clientId} request ${operation} failed: ${classification.message}`,
  })
}

const processInfrastructureFailure = (message: string) =>
  participantHostFailure({ code: 'host-infrastructure-failure', message, operationOutcome: 'definite-failure' })

const processResponseInvalid = (message: string) =>
  participantHostFailure({ code: 'host-response-invalid', message, operationOutcome: 'definite-failure' })

const unsupportedLifecycle = (operation: string) => (_command: { operationId: string }) =>
  Effect.fail(new ScenarioOperationError('capability-unavailable', `Process host does not support ${operation}`))
