import { EventSequenceNumber } from '@livestore/common/schema'
import { Effect, type Schema, type Scope } from '@livestore/utils/effect'

import { ScenarioOperationError } from '../application/definition.ts'
import {
  deriveScenarioTopology,
  type HostSystemObservation,
  type ParticipantRef,
  type ParticipantSnapshot,
  participantKey,
  type ScenarioAst,
  type SyncObservation,
  type SyncObservationPayload,
} from '../model.ts'
import type { HostError, ParticipantHost } from '../profiles/contract.ts'
import { canonicalJson, syncObservationPayload } from './eventlog.ts'
import {
  observationsAreSettled,
  recordObservedBackendFaultTransition,
  recordObservedFaultTransition,
  type ScenarioFaultState,
  selectedRecoveryFaults,
  settlementTimeoutError,
} from './faults.ts'
import { describeHostError } from './support.ts'
import type { TraceRecorder } from './trace-recorder.ts'

export const recordSystemObservation = (args: {
  host: ParticipantHost
  record: TraceRecorder
  reason: string
  correlationId?: string
  phaseId?: string
  observation?: HostSystemObservation
  faultState: ScenarioFaultState
}): Effect.Effect<void, HostError, Scope.Scope> =>
  Effect.gen(function* () {
    const captureId = args.record.nextCaptureId(args.reason)
    const observation = args.observation === undefined ? yield* args.host.observeSystem : args.observation
    const backendRecord = args.record({
      origin: 'observation',
      correlationId: args.correlationId,
      phaseId: args.phaseId,
      captureId,
      evidence: 'first-observed',
      occurrence: observation.occurrences.backend,
      payload: { _tag: 'backend.observed', reason: args.reason, observation: observation.backend },
    })
    recordObservedBackendFaultTransition({
      available: observation.backend.connected,
      backendRecord,
      faultState: args.faultState,
      record: args.record,
      phaseId: args.phaseId,
      captureId,
      occurrence: observation.occurrences.backend,
    })
    for (const client of observation.clients) {
      const clientOccurrences = observation.occurrences.clients.find((item) => item.clientId === client.clientId)
      if (clientOccurrences === undefined) {
        return yield* Effect.fail(
          new ScenarioOperationError(
            'invalid-observation-evidence',
            `System observation omitted timing evidence for Client ${client.clientId}`,
          ),
        )
      }
      const connectivityRecord = args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        clientId: client.clientId,
        phaseId: args.phaseId,
        captureId,
        evidence: 'first-observed',
        occurrence: clientOccurrences.connectivity,
        payload: { _tag: 'client.connectivity.observed', reason: args.reason, connected: client.connected },
      })
      recordObservedFaultTransition({
        clientId: client.clientId,
        connected: client.connected,
        connectivityRecord,
        faultState: args.faultState,
        record: args.record,
        phaseId: args.phaseId,
        captureId,
        occurrence: clientOccurrences.connectivity,
      })
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        clientId: client.clientId,
        phaseId: args.phaseId,
        captureId,
        evidence: 'first-observed',
        occurrence: clientOccurrences.leader,
        payload: { _tag: 'leader.sync.observed', reason: args.reason, observation: client.leader },
      })
      for (const session of client.sessions) {
        const sessionOccurrence = clientOccurrences.sessions.find((item) => item.sessionId === session.sessionId)
        if (sessionOccurrence === undefined) {
          return yield* Effect.fail(
            new ScenarioOperationError(
              'invalid-observation-evidence',
              `System observation omitted timing evidence for ${client.clientId}/${session.sessionId}`,
            ),
          )
        }
        args.record({
          origin: 'observation',
          correlationId: args.correlationId,
          clientId: client.clientId,
          sessionId: session.sessionId,
          phaseId: args.phaseId,
          captureId,
          evidence: 'first-observed',
          occurrence: sessionOccurrence.occurrence,
          payload: { _tag: 'session.sync.observed', reason: args.reason, observation: session.sync },
        })
      }
    }

    const runtimeFailures = yield* args.host.drainRuntimeFailures
    for (const failure of runtimeFailures) {
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        clientId: failure.clientId,
        sessionId: failure.sessionId ?? undefined,
        phaseId: args.phaseId,
        captureId,
        evidence: 'first-observed',
        payload: {
          _tag: 'runtime.failure.observed',
          source: failure.source,
          code: failure.code,
          message: failure.message,
        },
      })
    }
    const firstFailure = runtimeFailures[0]
    if (firstFailure !== undefined) {
      return yield* Effect.fail(
        new ScenarioOperationError(
          'participant-runtime-failure',
          `${firstFailure.clientId}/${firstFailure.sessionId ?? 'Leader'} reported ${firstFailure.code}: ${firstFailure.message}`,
        ),
      )
    }
  })

export const awaitSettlement = (args: {
  host: ParticipantHost
  participants: ReadonlyArray<ParticipantRef>
  timeoutMs: number
  record: TraceRecorder
  phaseId: string
  correlationId: string
  faultState: ScenarioFaultState
}): Effect.Effect<ReadonlyArray<SyncObservation>, HostError, Scope.Scope> => {
  const deadline = Date.now() + args.timeoutMs
  let lastLoggedSignature: string | undefined
  let lastObservations: ReadonlyArray<SyncObservationPayload> = []

  const loop = (
    previousStableSignature: string | undefined,
  ): Effect.Effect<ReadonlyArray<SyncObservation>, HostError, Scope.Scope> =>
    Effect.gen(function* () {
      // A browser-wide observation can remain busy while a large reconnect is
      // being applied. Let it consume the remaining settlement budget instead
      // of imposing a second, shorter deadline on the same bounded operation.
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return yield* Effect.fail(settlementTimeoutError(args.correlationId, args.timeoutMs, lastObservations))
      }
      const observationTimeoutMs = remainingMs
      const systemObservation = yield* args.host.observeSystem.pipe(
        Effect.timeoutOrElse({
          duration: observationTimeoutMs,
          orElse: () =>
            Effect.fail(
              new ScenarioOperationError(
                'settlement-timeout',
                `Settlement ${args.correlationId} timed out observing the system after ${observationTimeoutMs}ms`,
              ),
            ),
        }),
      )
      const observations = yield* Effect.forEach(args.participants, (participant) =>
        deriveSyncObservation({ observation: systemObservation, participant }),
      )
      const signature = canonicalJson(observations.map(syncObservationPayload))
      const isStable = observationsAreSettled(observations)
      lastObservations = observations.map(syncObservationPayload)
      if (process.env.SCENARIO_PROGRESS === '1' && signature !== lastLoggedSignature) {
        console.log(`  settlement ${args.correlationId}: ${signature}`)
        lastLoggedSignature = signature
      }
      const progress = args.record({
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
        observation: systemObservation,
        faultState: args.faultState,
      }).pipe(
        Effect.timeoutOrElse({
          duration: observationTimeoutMs,
          orElse: () =>
            Effect.fail(
              new ScenarioOperationError(
                'settlement-timeout',
                `Settlement ${args.correlationId} timed out recording its system observation after ${observationTimeoutMs}ms`,
              ),
            ),
        }),
      )

      const recoveryFaults = selectedRecoveryFaults(args.faultState, args.participants)
      const recoveryObservation =
        recoveryFaults.length === 0
          ? undefined
          : args.record({
              origin: 'observation',
              correlationId: args.correlationId,
              phaseId: args.phaseId,
              causedBy: [...recoveryFaults.map((fault) => fault.removalRecordIndex), progress.index],
              payload: {
                _tag: 'recovery.observed',
                faultIds: recoveryFaults.map((fault) => fault.faultId),
                converged: isStable,
                observations: lastObservations,
              },
            })

      if (isStable === true && previousStableSignature === signature) {
        if (recoveryObservation !== undefined) {
          args.record({
            origin: 'observation',
            correlationId: args.correlationId,
            phaseId: args.phaseId,
            causedBy: [recoveryObservation.index],
            payload: {
              _tag: 'recovery.completed',
              faultIds: recoveryFaults.map((fault) => fault.faultId),
              observations: lastObservations,
            },
          })
          for (const fault of recoveryFaults) {
            if (fault.scope === 'client') args.faultState.recoveringByClient.delete(fault.clientId)
            else args.faultState.backend.recovering = undefined
          }
        }
        return observations
      }
      if (Date.now() >= deadline) {
        return yield* Effect.fail(settlementTimeoutError(args.correlationId, args.timeoutMs, lastObservations))
      }
      // A browser settlement probe crosses every page plus the backend. A
      // moderate cadence leaves room for the sync work being observed.
      yield* Effect.sleep('100 millis')
      return yield* loop(isStable === true ? signature : undefined)
    })

  return Effect.suspend(() => loop(undefined)).pipe(
    Effect.catch((error) => {
      const failure = describeHostError(error)
      args.record({
        origin: 'observation',
        correlationId: args.correlationId,
        phaseId: args.phaseId,
        payload: {
          _tag: 'settlement.failed',
          ...failure,
          timeoutMs: args.timeoutMs,
          observations: lastObservations,
        },
      })
      return Effect.fail(error)
    }),
  )
}

const deriveSyncObservation = (args: {
  observation: HostSystemObservation
  participant: ParticipantRef
}): Effect.Effect<SyncObservation, ScenarioOperationError> => {
  const client = args.observation.clients.find((candidate) => candidate.clientId === args.participant.clientId)
  const session = client?.sessions.find((candidate) => candidate.sessionId === args.participant.sessionId)
  if (client === undefined || session === undefined) {
    return Effect.fail(
      new ScenarioOperationError(
        'missing-participant',
        `System observation omitted ${participantKey(args.participant)}`,
      ),
    )
  }

  const backendHead = EventSequenceNumber.Client.fromString(args.observation.backend.head)
  const leaderLocalHead = EventSequenceNumber.Client.fromString(client.leader.localHead)
  const leaderUpstreamHead = EventSequenceNumber.Client.fromString(client.leader.upstreamHead)
  const sessionLocalHead = EventSequenceNumber.Client.fromString(session.sync.localHead)
  const sessionUpstreamHead = EventSequenceNumber.Client.fromString(session.sync.upstreamHead)
  const pendingCount = Math.max(
    client.leader.pendingCount,
    session.sync.pendingCount,
    leaderLocalHead.client,
    leaderUpstreamHead.client,
    sessionLocalHead.client,
    sessionUpstreamHead.client,
  )
  const componentHeads = [leaderLocalHead, leaderUpstreamHead, sessionLocalHead, sessionUpstreamHead]
  return Effect.succeed({
    participant: args.participant,
    localHead: session.sync.localHead,
    upstreamHead: args.observation.backend.head,
    pendingCount,
    isSynced:
      args.observation.backend.connected === true &&
      client.connected === true &&
      pendingCount === 0 &&
      componentHeads.every((head) => head.global === backendHead.global),
  })
}

export const captureSnapshots = (args: {
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
  const participants = deriveScenarioTopology(args.scenario).flatMap((client) =>
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
