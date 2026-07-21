import type { LiveStoreSchema } from '@livestore/common/schema'
import { EventSequenceNumber } from '@livestore/common/schema'
import type { WranglerDevServer } from '@livestore/utils-dev/wrangler'
import { Effect, FetchHttpClient, Layer, type OtelTracer, Schema, type Scope } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { type ApplicationDefinition, ScenarioOperationError } from './application.ts'
import { makeLocalSyncCfScenarioBackend, makeMockScenarioBackend } from './backends.ts'
import { makeBrowserHost } from './browser/browser-host.ts'
import { makeInProcessHost, type HostError, type ParticipantHost } from './host.ts'
import {
  type OracleVerdict,
  type ExecutionConfiguration,
  type ParticipantRef,
  type ParticipantSnapshot,
  participantKey,
  type ScenarioAst,
  type ScenarioOracle,
  scenarioArtifactVersion,
  ScenarioRunArtifact,
  type ScenarioStep,
  scenarioTraceVersion,
  type ScenarioTracePayload,
  type ScenarioTraceRecord,
  type SyncObservationPayload,
  type SyncObservation,
} from './model.ts'
import { makeProcessHost } from './process/process-host.ts'

export interface RunScenarioOptions {
  readonly runId?: string
  readonly sourceRevision?: string
  readonly execution?: ExecutionConfiguration
}

export const defaultInProcessExecution: ExecutionConfiguration = {
  participantProfile: 'in-process',
  syncBackend: 'mock',
  stateProfile: 'sqlite',
}

export const runInProcessScenario = <TSchema extends LiveStoreSchema>(args: {
  scenario: ScenarioAst
  application: ApplicationDefinition<TSchema>
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const backend = yield* makeMockScenarioBackend
    const host = yield* makeInProcessHost({ application: args.application, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.application.id,
      host,
      options: { ...args.options, execution: args.options?.execution ?? defaultInProcessExecution },
    })
  })

export const runInProcessLocalSyncCfScenario = <TSchema extends LiveStoreSchema>(args: {
  scenario: ScenarioAst
  application: ApplicationDefinition<TSchema>
  options?: RunScenarioOptions
}): Effect.Effect<
  ScenarioRunArtifact,
  HostError | WranglerDevServer.WranglerDevServerError,
  Scope.Scope | OtelTracer.OtelTracer
> =>
  Effect.gen(function* () {
    const backend = yield* makeLocalSyncCfScenarioBackend.pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeInProcessHost({ application: args.application, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.application.id,
      host,
      options: {
        ...args.options,
        execution: {
          participantProfile: 'in-process',
          syncBackend: 'local-sync-cf',
          stateProfile: 'sqlite',
        },
      },
    })
  })

export const runProcessLocalSyncCfScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  options?: RunScenarioOptions
}): Effect.Effect<
  ScenarioRunArtifact,
  HostError | WranglerDevServer.WranglerDevServerError,
  Scope.Scope | OtelTracer.OtelTracer
> =>
  Effect.gen(function* () {
    const backend = yield* makeLocalSyncCfScenarioBackend.pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeProcessHost({ applicationId: args.applicationId, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.applicationId,
      host,
      options: {
        ...args.options,
        execution: {
          participantProfile: 'process',
          syncBackend: 'local-sync-cf',
          stateProfile: 'sqlite',
        },
      },
    })
  })

export const runBrowserLocalSyncCfScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  options?: RunScenarioOptions
}): Effect.Effect<
  ScenarioRunArtifact,
  HostError | WranglerDevServer.WranglerDevServerError,
  Scope.Scope | OtelTracer.OtelTracer
> =>
  Effect.gen(function* () {
    const backend = yield* makeLocalSyncCfScenarioBackend.pipe(
      Effect.provide(Layer.mergeAll(PlatformNode.NodeServices.layer, FetchHttpClient.layer)),
    )
    const host = yield* makeBrowserHost({ applicationId: args.applicationId, backend })
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.applicationId,
      host,
      options: {
        ...args.options,
        execution: {
          participantProfile: 'browser',
          syncBackend: 'local-sync-cf',
          stateProfile: 'opfs',
        },
      },
    })
  })

/** Executes only against the transport-neutral host surface and emits the portable artifact. */
export const runScenario = (args: {
  scenario: ScenarioAst
  applicationId: string
  host: ParticipantHost
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const execution = args.options?.execution ?? defaultInProcessExecution
    yield* validateExecution({ ...args, execution })

    const runId = args.options?.runId ?? `${args.scenario.id}:${args.scenario.seed}:${Date.now()}`
    const trace: ScenarioTraceRecord[] = []
    let logicalTime = 0
    const record = makeTraceRecorder({ runId, trace, readLogicalTime: () => logicalTime })

    record({
      origin: 'observation',
      payload: {
        _tag: 'run.started',
        scenarioId: args.scenario.id,
        applicationId: args.applicationId,
        seed: args.scenario.seed,
      },
    })
    yield* recordSystemObservation({ host: args.host, record, reason: 'run-started' })

    for (const client of args.scenario.topology.clients) {
      const operationId = `create:${client.id}`
      record({
        origin: 'instruction',
        correlationId: operationId,
        clientId: client.id,
        payload: {
          _tag: 'client.create.requested',
          sessions: [...client.sessions],
          initiallyConnected: client.initiallyConnected,
        },
      })
      yield* args.host.createClient({ operationId, storeId: args.scenario.topology.storeId, client })
      record({
        origin: 'acknowledgement',
        correlationId: operationId,
        clientId: client.id,
        payload: { _tag: 'client.created', status: 'acknowledged' },
      })
      yield* recordSystemObservation({ host: args.host, record, reason: operationId, correlationId: operationId })
    }

    for (const phase of args.scenario.phases) {
      logicalTime += 1
      record({
        origin: 'observation',
        phaseId: phase.id,
        payload: { _tag: 'phase.started', description: phase.description },
      })
      for (const step of phase.steps) {
        logicalTime += 1
        yield* executeStep({ host: args.host, phaseId: phase.id, record, step })
        yield* recordSystemObservation({
          host: args.host,
          record,
          reason: step.id,
          correlationId: step.id,
          phaseId: phase.id,
        })
      }
      record({ origin: 'observation', phaseId: phase.id, payload: { _tag: 'phase.completed' } })
    }

    const snapshotResult = yield* captureSnapshots({ host: args.host, scenario: args.scenario, record })
    const verdicts = evaluateOracles({
      oracles: args.scenario.oracles,
      snapshots: snapshotResult.snapshots,
      evidenceByParticipant: snapshotResult.evidenceByParticipant,
      record,
    })
    const status = verdicts.every((verdict) => verdict.status === 'passed') === true ? 'passed' : 'failed'

    record({ origin: 'observation', payload: { _tag: 'run.completed', status } })

    return yield* Schema.decodeUnknownEffect(ScenarioRunArtifact)({
      artifactVersion: scenarioArtifactVersion,
      descriptor: {
        runId,
        scenarioId: args.scenario.id,
        scenarioVersion: args.scenario.version,
        traceVersion: scenarioTraceVersion,
        applicationId: args.applicationId,
        sourceRevision: args.options?.sourceRevision ?? 'working-tree',
        seed: args.scenario.seed,
        reproductionMode: 'seeded',
        execution,
        capabilities: args.host.capabilities,
        componentVersions: args.host.componentVersions,
      },
      scenario: args.scenario,
      trace,
      verdicts,
      snapshots: snapshotResult.snapshots,
      status,
    }).pipe(Effect.orDie)
  })

type TraceInput = {
  readonly origin: ScenarioTraceRecord['origin']
  readonly payload: ScenarioTracePayload
  readonly correlationId?: string
  readonly causationId?: string
  readonly clientId?: string
  readonly sessionId?: string
  readonly phaseId?: string
}

type TraceRecorder = (input: TraceInput) => ScenarioTraceRecord

const makeTraceRecorder = (args: {
  runId: string
  trace: ScenarioTraceRecord[]
  readLogicalTime: () => number
}): TraceRecorder => {
  let index = 0
  return (input) => {
    const record: ScenarioTraceRecord = {
      traceVersion: scenarioTraceVersion,
      runId: args.runId,
      index,
      origin: input.origin,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      clientId: input.clientId ?? null,
      sessionId: input.sessionId ?? null,
      phaseId: input.phaseId ?? null,
      logicalTime: args.readLogicalTime(),
      wallTimeMs: Date.now(),
      payload: input.payload,
    }
    index += 1
    args.trace.push(record)
    return record
  }
}

const executeStep = (args: {
  host: ParticipantHost
  phaseId: string
  record: TraceRecorder
  step: ScenarioStep
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> => {
  switch (args.step._tag) {
    case 'action': {
      const step = args.step
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload: { _tag: 'action.requested', action: step.action, input: step.input },
        })
        yield* args.host.dispatchAction({
          operationId: step.id,
          target: step.target,
          action: step.action,
          input: step.input,
        })
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload: { _tag: 'action.completed', action: step.action, status: 'acknowledged' },
        })
      })
    }
    case 'disconnect':
    case 'reconnect': {
      const connected = args.step._tag === 'reconnect'
      return setConnectivity({
        host: args.host,
        phaseId: args.phaseId,
        record: args.record,
        clientId: args.step.clientId,
        operationId: args.step.id,
        connected,
      })
    }
    case 'stop-session':
    case 'restart-session': {
      const step = args.step
      const restarting = step._tag === 'restart-session'
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload:
            restarting === true
              ? { _tag: 'lifecycle.session-restart.requested' }
              : { _tag: 'lifecycle.session-stop.requested' },
        })
        const command = { operationId: step.id, target: step.target }
        if (restarting === true) yield* args.host.restartSession(command)
        else yield* args.host.stopSession(command)
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload:
            restarting === true ? { _tag: 'lifecycle.session-restarted' } : { _tag: 'lifecycle.session-stopped' },
        })
      })
    }
    case 'restart-client': {
      const step = args.step
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          clientId: step.clientId,
          phaseId: args.phaseId,
          payload: { _tag: 'lifecycle.client-restart.requested' },
        })
        yield* args.host.restartClient({ operationId: step.id, clientId: step.clientId })
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          clientId: step.clientId,
          phaseId: args.phaseId,
          payload: { _tag: 'lifecycle.client-restarted' },
        })
      })
    }
    case 'settle': {
      const step = args.step
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          correlationId: step.id,
          phaseId: args.phaseId,
          payload: {
            _tag: 'settlement.requested',
            participants: step.participants.map(participantKey),
            healDisconnectedClients: [...step.healDisconnectedClients],
            timeoutMs: step.timeoutMs,
          },
        })
        for (const clientId of step.healDisconnectedClients) {
          yield* setConnectivity({
            host: args.host,
            phaseId: args.phaseId,
            record: args.record,
            clientId,
            operationId: `${step.id}:heal:${clientId}`,
            connected: true,
          })
        }
        const settled = yield* awaitSettlement({
          host: args.host,
          participants: step.participants,
          timeoutMs: step.timeoutMs,
          record: args.record,
          phaseId: args.phaseId,
          correlationId: step.id,
        })
        args.record({
          origin: 'acknowledgement',
          correlationId: step.id,
          phaseId: args.phaseId,
          payload: { _tag: 'settlement.completed', observations: settled.map(syncObservationPayload) },
        })
      })
    }
  }
}

const setConnectivity = (args: {
  host: ParticipantHost
  phaseId: string
  record: TraceRecorder
  clientId: string
  operationId: string
  connected: boolean
}): Effect.Effect<void, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    args.record({
      origin: 'instruction',
      correlationId: args.operationId,
      clientId: args.clientId,
      phaseId: args.phaseId,
      payload:
        args.connected === true
          ? { _tag: 'connectivity.reconnect.requested', connected: true }
          : { _tag: 'connectivity.disconnect.requested', connected: false },
    })
    yield* args.host.setConnectivity({
      operationId: args.operationId,
      clientId: args.clientId,
      connected: args.connected,
    })
    args.record({
      origin: 'acknowledgement',
      correlationId: args.operationId,
      clientId: args.clientId,
      phaseId: args.phaseId,
      payload:
        args.connected === true
          ? { _tag: 'connectivity.reconnected', connected: true }
          : { _tag: 'connectivity.disconnected', connected: false },
    })
  })

/** Records component-scoped facts so every cursor advances one observed component at a time. */
const recordSystemObservation = (args: {
  host: ParticipantHost
  record: TraceRecorder
  reason: string
  correlationId?: string
  phaseId?: string
}): Effect.Effect<void, HostError, Scope.Scope> =>
  Effect.gen(function* () {
    const observation = yield* args.host.observeSystem
    args.record({
      origin: 'observation',
      correlationId: args.correlationId,
      causationId: args.correlationId,
      phaseId: args.phaseId,
      payload: { _tag: 'backend.observed', reason: args.reason, observation: observation.backend },
    })
    for (const client of observation.clients) {
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        causationId: args.correlationId,
        clientId: client.clientId,
        phaseId: args.phaseId,
        payload: { _tag: 'client.connectivity.observed', reason: args.reason, connected: client.connected },
      })
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        causationId: args.correlationId,
        clientId: client.clientId,
        phaseId: args.phaseId,
        payload: { _tag: 'leader.sync.observed', reason: args.reason, observation: client.leader },
      })
      for (const session of client.sessions) {
        args.record({
          origin: 'observation',
          correlationId: args.correlationId,
          causationId: args.correlationId,
          clientId: client.clientId,
          sessionId: session.sessionId,
          phaseId: args.phaseId,
          payload: { _tag: 'session.sync.observed', reason: args.reason, observation: session.sync },
        })
      }
    }
  })

const awaitSettlement = (args: {
  host: ParticipantHost
  participants: ReadonlyArray<ParticipantRef>
  timeoutMs: number
  record: TraceRecorder
  phaseId: string
  correlationId: string
}): Effect.Effect<ReadonlyArray<SyncObservation>, HostError, Scope.Scope> => {
  const deadline = Date.now() + args.timeoutMs

  const loop = (
    previousStableSignature: string | undefined,
  ): Effect.Effect<ReadonlyArray<SyncObservation>, HostError, Scope.Scope> =>
    Effect.gen(function* () {
      const observations = yield* Effect.forEach(args.participants, args.host.observeSync)
      const signature = canonicalJson(observations.map(syncObservationPayload))
      const isStable = observationsAreSettled(observations)
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        phaseId: args.phaseId,
        payload: {
          _tag: 'settlement.progress',
          settled: isStable,
          observations: observations.map(syncObservationPayload),
        },
      })
      yield* recordSystemObservation({
        host: args.host,
        record: args.record,
        reason: 'settlement-poll',
        correlationId: args.correlationId,
        phaseId: args.phaseId,
      })

      if (isStable === true && previousStableSignature === signature) return observations
      if (Date.now() >= deadline) {
        return yield* Effect.fail(
          new ScenarioOperationError(
            'settlement-timeout',
            `Settlement ${args.correlationId} did not reach a stable fixed point within ${args.timeoutMs}ms: ${signature}`,
          ),
        )
      }
      yield* Effect.sleep('25 millis')
      return yield* loop(isStable === true ? signature : undefined)
    })

  return Effect.suspend(() => loop(undefined))
}

const captureSnapshots = (args: {
  host: ParticipantHost
  scenario: ScenarioAst
  record: TraceRecorder
}): Effect.Effect<
  {
    snapshots: ReadonlyArray<ParticipantSnapshot>
    evidenceByParticipant: ReadonlyMap<string, ReadonlyArray<number>>
  },
  HostError,
  Scope.Scope
> => {
  const inspectorNames = [
    ...new Set(
      args.scenario.oracles.flatMap((oracle) =>
        oracle._tag === 'state-convergence' || oracle._tag === 'state-contains-ids' ? [oracle.inspector] : [],
      ),
    ),
  ]
  const participants = args.scenario.topology.clients.flatMap((client) =>
    client.sessions.map((sessionId) => ({ clientId: client.id, sessionId })),
  )

  return Effect.gen(function* () {
    const evidenceByParticipant = new Map<string, number[]>()
    const snapshots = yield* Effect.forEach(participants, (participant) =>
      Effect.gen(function* () {
        const sync = yield* args.host.observeSync(participant)
        const syncRecord = args.record({
          origin: 'observation',
          clientId: participant.clientId,
          sessionId: participant.sessionId,
          payload: { _tag: 'sync.snapshot', ...syncObservationPayload(sync) },
        })
        const evidence = [syncRecord.index]
        const state: Record<string, Schema.Json> = {}
        for (const inspector of inspectorNames) {
          const operationId = `inspect:${participantKey(participant)}:${inspector}`
          const inspected = yield* args.host.inspectState({ operationId, target: participant, inspector })
          state[inspector] = inspected
          const stateRecord = args.record({
            origin: 'observation',
            correlationId: operationId,
            clientId: participant.clientId,
            sessionId: participant.sessionId,
            payload: { _tag: 'state.snapshot', inspector, value: inspected },
          })
          evidence.push(stateRecord.index)
        }
        evidenceByParticipant.set(participantKey(participant), evidence)
        return { participant, sync, state }
      }),
    )
    return { snapshots, evidenceByParticipant }
  })
}

const evaluateOracles = (args: {
  oracles: ReadonlyArray<ScenarioOracle>
  snapshots: ReadonlyArray<ParticipantSnapshot>
  evidenceByParticipant: ReadonlyMap<string, ReadonlyArray<number>>
  record: TraceRecorder
}): ReadonlyArray<OracleVerdict> =>
  args.oracles.map((oracle) => {
    const selected = oracle.participants.map((participant) =>
      args.snapshots.find((snapshot) => participantKey(snapshot.participant) === participantKey(participant)),
    )
    const evidence = oracle.participants.flatMap(
      (participant) => args.evidenceByParticipant.get(participantKey(participant)) ?? [],
    )
    const verdict = evaluateOracle(oracle, selected, evidence)
    args.record({
      origin: 'verdict',
      correlationId: oracle.id,
      payload: {
        _tag: 'oracle.verdict',
        oracleId: verdict.oracleId,
        oracle: verdict.oracle,
        status: verdict.status,
        summary: verdict.summary,
        evidence: [...verdict.evidence],
      },
    })
    return verdict
  })

const evaluateOracle = (
  oracle: ScenarioOracle,
  selected: ReadonlyArray<ParticipantSnapshot | undefined>,
  evidence: ReadonlyArray<number>,
): OracleVerdict => {
  if (selected.some((snapshot) => snapshot === undefined) === true) {
    return failedVerdict(oracle, evidence, 'One or more expected participant snapshots are missing')
  }
  const snapshots = selected.filter((snapshot): snapshot is ParticipantSnapshot => snapshot !== undefined)

  switch (oracle._tag) {
    case 'pending-resolution': {
      const passed = snapshots.every((snapshot) => snapshot.sync.pendingCount === 0 && snapshot.sync.isSynced === true)
      return passed === true
        ? passedVerdict(oracle, evidence, 'All expected participants have resolved pending events')
        : failedVerdict(oracle, evidence, 'At least one expected participant still has pending events')
    }
    case 'eventlog-convergence': {
      const heads = new Set(snapshots.map((snapshot) => globalPosition(snapshot.sync.upstreamHead)))
      const passed =
        heads.size === 1 &&
        snapshots.every(
          (snapshot) =>
            snapshot.sync.pendingCount === 0 &&
            globalPosition(snapshot.sync.localHead) === globalPosition(snapshot.sync.upstreamHead),
        )
      return passed === true
        ? passedVerdict(oracle, evidence, 'All expected participants share one settled authoritative head')
        : failedVerdict(oracle, evidence, 'Expected participants do not share one settled authoritative head')
    }
    case 'state-convergence': {
      const values = snapshots.map((snapshot) => canonicalJson(snapshot.state[oracle.inspector]))
      const passed = new Set(values).size === 1 && values[0] !== undefined
      return passed === true
        ? passedVerdict(oracle, evidence, `Inspector ${oracle.inspector} converged across expected participants`)
        : failedVerdict(oracle, evidence, `Inspector ${oracle.inspector} diverged across expected participants`)
    }
    case 'state-contains-ids': {
      const missingByParticipant = snapshots.flatMap((snapshot) => {
        const ids = readIds(snapshot.state[oracle.inspector])
        const missing = oracle.expectedIds.filter((id) => ids.has(id) === false)
        return missing.length === 0 ? [] : [`${participantKey(snapshot.participant)}: ${missing.join(', ')}`]
      })
      return missingByParticipant.length === 0
        ? passedVerdict(oracle, evidence, `All expected IDs are present in inspector ${oracle.inspector}`)
        : failedVerdict(oracle, evidence, `Missing IDs (${missingByParticipant.join('; ')})`)
    }
  }
}

const validateExecution = (args: {
  scenario: ScenarioAst
  applicationId: string
  host: ParticipantHost
  execution: ExecutionConfiguration
}): Effect.Effect<void, ScenarioOperationError> => {
  if (args.scenario.applicationId !== args.applicationId) {
    return Effect.fail(
      new ScenarioOperationError(
        'application-mismatch',
        `Scenario requires ${args.scenario.applicationId}, received ${args.applicationId}`,
      ),
    )
  }
  if (args.execution.participantProfile !== args.host.capabilities.profile) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Execution selected ${args.execution.participantProfile}, received ${args.host.capabilities.profile} host`,
      ),
    )
  }
  if (args.execution.syncBackend !== args.host.backendId) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Execution selected ${args.execution.syncBackend}, received ${args.host.backendId} backend`,
      ),
    )
  }
  const available = new Set(args.host.capabilities.capabilities)
  const stateCapability = args.execution.stateProfile === 'opfs' ? 'opfs-state' : 'sqlite-state'
  if (available.has(stateCapability) === false) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Host ${args.host.capabilities.profile} does not provide ${args.execution.stateProfile} state`,
      ),
    )
  }
  const missing = args.scenario.requires.filter((capability) => available.has(capability) === false)
  if (missing.length > 0) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Host ${args.host.capabilities.profile} does not provide: ${missing.join(', ')}`,
      ),
    )
  }
  return Effect.void
}

const observationsAreSettled = (observations: ReadonlyArray<SyncObservation>): boolean => {
  if (observations.length === 0) return false
  const heads = new Set(observations.map((observation) => globalPosition(observation.upstreamHead)))
  return (
    heads.size === 1 &&
    observations.every(
      (observation) =>
        observation.pendingCount === 0 &&
        observation.isSynced === true &&
        globalPosition(observation.localHead) === globalPosition(observation.upstreamHead),
    )
  )
}

const globalPosition = (head: string): number => EventSequenceNumber.Client.fromString(head).global

const syncObservationPayload = (observation: SyncObservation): SyncObservationPayload => ({
  participant: participantKey(observation.participant),
  localHead: observation.localHead,
  upstreamHead: observation.upstreamHead,
  pendingCount: observation.pendingCount,
  isSynced: observation.isSynced,
})

const canonicalJson = (value: Schema.Json | undefined): string | undefined =>
  value === undefined ? undefined : Schema.encodeUnknownSync(Schema.UnknownFromJsonString)(sortJson(value))

const sortJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value) === true) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}

const readIds = (value: Schema.Json | undefined): ReadonlySet<string> => {
  if (Array.isArray(value) === false) return new Set()
  return new Set(
    value.flatMap((item) =>
      item !== null && typeof item === 'object' && Array.isArray(item) === false && typeof item.id === 'string'
        ? [item.id]
        : [],
    ),
  )
}

const passedVerdict = (oracle: ScenarioOracle, evidence: ReadonlyArray<number>, summary: string): OracleVerdict => ({
  oracleId: oracle.id,
  oracle: oracle._tag,
  status: 'passed',
  summary,
  evidence,
})

const failedVerdict = (oracle: ScenarioOracle, evidence: ReadonlyArray<number>, summary: string): OracleVerdict => ({
  oracleId: oracle.id,
  oracle: oracle._tag,
  status: 'failed',
  summary,
  evidence,
})
