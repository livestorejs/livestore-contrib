import type { LiveStoreSchema } from '@livestore/common/schema'
import { EventSequenceNumber } from '@livestore/common/schema'
import { Effect, type OtelTracer, Schema, type Scope } from '@livestore/utils/effect'

import { type ApplicationDefinition, ScenarioOperationError } from './application.ts'
import { makeInProcessHost, type HostError, type ParticipantHost } from './host.ts'
import {
  type OracleVerdict,
  type ParticipantRef,
  type ParticipantSnapshot,
  participantKey,
  type ScenarioAst,
  type ScenarioOracle,
  ScenarioRunArtifact,
  type ScenarioStep,
  type ScenarioTraceRecord,
  type SyncObservation,
} from './model.ts'

export interface RunScenarioOptions {
  readonly runId?: string
  readonly sourceRevision?: string
}

export const runInProcessScenario = <TSchema extends LiveStoreSchema>(args: {
  scenario: ScenarioAst
  application: ApplicationDefinition<TSchema>
  options?: RunScenarioOptions
}): Effect.Effect<ScenarioRunArtifact, HostError, Scope.Scope | OtelTracer.OtelTracer> =>
  Effect.gen(function* () {
    const host = yield* makeInProcessHost(args.application)
    return yield* runScenario({
      scenario: args.scenario,
      applicationId: args.application.id,
      host,
      options: args.options,
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
    yield* validateExecution(args)

    const runId = args.options?.runId ?? `${args.scenario.id}:${args.scenario.seed}:${Date.now()}`
    const trace: ScenarioTraceRecord[] = []
    let logicalTime = 0
    const record = makeTraceRecorder({ runId, trace, readLogicalTime: () => logicalTime })

    record({
      origin: 'observation',
      kind: 'run.started',
      payload: {
        scenarioId: args.scenario.id,
        applicationId: args.applicationId,
        seed: args.scenario.seed,
      },
    })

    for (const client of args.scenario.topology.clients) {
      const operationId = `create:${client.id}`
      record({
        origin: 'instruction',
        kind: 'client.create.requested',
        correlationId: operationId,
        clientId: client.id,
        payload: { sessions: [...client.sessions], initiallyConnected: client.initiallyConnected },
      })
      yield* args.host.createClient({ operationId, storeId: args.scenario.topology.storeId, client })
      record({
        origin: 'acknowledgement',
        kind: 'client.created',
        correlationId: operationId,
        clientId: client.id,
        payload: { status: 'acknowledged' },
      })
    }

    for (const phase of args.scenario.phases) {
      logicalTime += 1
      record({
        origin: 'observation',
        kind: 'phase.started',
        phaseId: phase.id,
        payload: { description: phase.description },
      })
      for (const step of phase.steps) {
        logicalTime += 1
        yield* executeStep({ host: args.host, phaseId: phase.id, record, step })
      }
      record({ origin: 'observation', kind: 'phase.completed', phaseId: phase.id, payload: {} })
    }

    const snapshotResult = yield* captureSnapshots({ host: args.host, scenario: args.scenario, record })
    const verdicts = evaluateOracles({
      oracles: args.scenario.oracles,
      snapshots: snapshotResult.snapshots,
      evidenceByParticipant: snapshotResult.evidenceByParticipant,
      record,
    })
    const status = verdicts.every((verdict) => verdict.status === 'passed') === true ? 'passed' : 'failed'

    record({ origin: 'observation', kind: 'run.completed', payload: { status } })

    return yield* Schema.decodeUnknownEffect(ScenarioRunArtifact)({
      artifactVersion: 1,
      descriptor: {
        runId,
        scenarioId: args.scenario.id,
        scenarioVersion: args.scenario.version,
        traceVersion: 1,
        applicationId: args.applicationId,
        sourceRevision: args.options?.sourceRevision ?? 'working-tree',
        seed: args.scenario.seed,
        reproductionMode: 'seeded',
        execution: args.scenario.execution,
        capabilities: args.host.capabilities,
        componentVersions: { '@livestore/livestore': 'workspace' },
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
  readonly kind: string
  readonly payload: Schema.Json
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
      traceVersion: 1,
      runId: args.runId,
      index,
      origin: input.origin,
      kind: input.kind,
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
          kind: 'action.requested',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload: { action: step.action, input: step.input },
        })
        yield* args.host.dispatchAction({
          operationId: step.id,
          target: step.target,
          action: step.action,
          input: step.input,
        })
        args.record({
          origin: 'acknowledgement',
          kind: 'action.completed',
          correlationId: step.id,
          clientId: step.target.clientId,
          sessionId: step.target.sessionId,
          phaseId: args.phaseId,
          payload: { action: step.action, status: 'acknowledged' },
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
    case 'settle': {
      const step = args.step
      return Effect.gen(function* () {
        args.record({
          origin: 'instruction',
          kind: 'settlement.requested',
          correlationId: step.id,
          phaseId: args.phaseId,
          payload: {
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
          kind: 'settlement.completed',
          correlationId: step.id,
          phaseId: args.phaseId,
          payload: { observations: settled.map(syncObservationPayload) },
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
      kind: args.connected === true ? 'connectivity.reconnect.requested' : 'connectivity.disconnect.requested',
      correlationId: args.operationId,
      clientId: args.clientId,
      phaseId: args.phaseId,
      payload: { connected: args.connected },
    })
    yield* args.host.setConnectivity({
      operationId: args.operationId,
      clientId: args.clientId,
      connected: args.connected,
    })
    args.record({
      origin: 'acknowledgement',
      kind: args.connected === true ? 'connectivity.reconnected' : 'connectivity.disconnected',
      correlationId: args.operationId,
      clientId: args.clientId,
      phaseId: args.phaseId,
      payload: { connected: args.connected },
    })
  })

const awaitSettlement = (args: {
  host: ParticipantHost
  participants: ReadonlyArray<ParticipantRef>
  timeoutMs: number
  record: TraceRecorder
  phaseId: string
  correlationId: string
}): Effect.Effect<ReadonlyArray<SyncObservation>, HostError> => {
  const deadline = Date.now() + args.timeoutMs

  const loop = (
    previousStableSignature: string | undefined,
  ): Effect.Effect<ReadonlyArray<SyncObservation>, HostError> =>
    Effect.gen(function* () {
      const observations = yield* Effect.forEach(args.participants, args.host.observeSync)
      const signature = canonicalJson(observations.map(syncObservationPayload))
      const isStable = observationsAreSettled(observations)
      args.record({
        origin: 'observation',
        kind: 'settlement.progress',
        correlationId: args.correlationId,
        phaseId: args.phaseId,
        payload: { settled: isStable, observations: observations.map(syncObservationPayload) },
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
  HostError
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
          kind: 'sync.snapshot',
          clientId: participant.clientId,
          sessionId: participant.sessionId,
          payload: syncObservationPayload(sync),
        })
        const evidence = [syncRecord.index]
        const state: Record<string, Schema.Json> = {}
        for (const inspector of inspectorNames) {
          const operationId = `inspect:${participantKey(participant)}:${inspector}`
          const inspected = yield* args.host.inspectState({ operationId, target: participant, inspector })
          state[inspector] = inspected
          const stateRecord = args.record({
            origin: 'observation',
            kind: 'state.snapshot',
            correlationId: operationId,
            clientId: participant.clientId,
            sessionId: participant.sessionId,
            payload: { inspector, value: inspected },
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
      kind: 'oracle.verdict',
      correlationId: oracle.id,
      payload: {
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
}): Effect.Effect<void, ScenarioOperationError> => {
  if (args.scenario.applicationId !== args.applicationId) {
    return Effect.fail(
      new ScenarioOperationError(
        'application-mismatch',
        `Scenario requires ${args.scenario.applicationId}, received ${args.applicationId}`,
      ),
    )
  }
  const available = new Set(args.host.capabilities.capabilities)
  const missing = args.scenario.execution.requires.filter((capability) => available.has(capability) === false)
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

const syncObservationPayload = (observation: SyncObservation): Schema.Json => ({
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
