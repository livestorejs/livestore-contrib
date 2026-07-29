export const evaluateOracles = (args: {
  oracles: ReadonlyArray<ScenarioOracle>
  snapshots: ReadonlyArray<ParticipantSnapshot>
  evidenceByParticipant: ReadonlyMap<string, ReadonlyArray<number>>
  trace: ReadonlyArray<ScenarioTraceRecord>
  record: TraceRecorder
}): ReadonlyArray<OracleVerdict> =>
  args.oracles.map((oracle) => {
    const verdict =
      oracle._tag === 'operation-history'
        ? evaluateOperationHistoryOracle(oracle, args.trace)
        : oracle._tag === 'confirmed-eventlog-prefix'
          ? evaluateConfirmedEventlogPrefixOracle(oracle, args.trace)
          : oracle._tag === 'eventlog-convergence'
            ? evaluateEventlogConvergenceOracle(oracle, args.trace)
            : evaluateSnapshotOracle(
                oracle,
                oracle.participants.map((participant) =>
                  args.snapshots.find(
                    (snapshot) => participantKey(snapshot.participant) === participantKey(participant),
                  ),
                ),
                oracle.participants.flatMap(
                  (participant) => args.evidenceByParticipant.get(participantKey(participant)) ?? [],
                ),
              )
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

const evaluateSnapshotOracle = (
  oracle: Exclude<ScenarioOracle, OperationHistoryOracle | EventlogConvergenceOracle | ConfirmedEventlogPrefixOracle>,
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

export interface CanonicalObservedEvent {
  readonly fact: string
  readonly position: string
  readonly description: string
}

export interface ObservedConfirmedPrefix {
  readonly events: ReadonlyArray<CanonicalObservedEvent>
  readonly recordIndex: number
}

/** Checks retained complete observations without claiming continuous visibility between samples. */
const evaluateConfirmedEventlogPrefixOracle = (
  oracle: ConfirmedEventlogPrefixOracle,
  trace: ReadonlyArray<ScenarioTraceRecord>,
): OracleVerdict => {
  const selectedComponents = new Map<string, string>([[backendComponentKey, 'backend']])
  for (const participant of oracle.participants) {
    selectedComponents.set(leaderComponentKey(participant.clientId), `Client ${participant.clientId} Leader`)
    selectedComponents.set(
      sessionComponentKey(participant.clientId, participant.sessionId),
      participantKey(participant),
    )
  }

  const previousByComponent = new Map<string, ObservedConfirmedPrefix>()
  const observationCountByComponent = new Map<string, number>()
  const evidence: number[] = []
  let comparisonCount = 0
  let repeatedEncodingCount = 0

  for (const record of trace) {
    if (record.captureId === null) continue
    const observation = observedComponentEventlog(record)
    if (observation === undefined || selectedComponents.has(observation.key) === false) continue

    const canonical = canonicalConfirmedEvents(observation.events)
    if (canonical._tag === 'conflict') {
      return failedVerdict(
        oracle,
        [...evidence, record.index],
        `${selectedComponents.get(observation.key)} has conflicting confirmed Event facts at global position ${canonical.position} in observation #${record.index + 1}`,
      )
    }
    const confirmed = canonical.events
    repeatedEncodingCount += canonical.repeatedEncodingCount
    evidence.push(record.index)
    observationCountByComponent.set(observation.key, (observationCountByComponent.get(observation.key) ?? 0) + 1)
    const previous = previousByComponent.get(observation.key)
    if (previous !== undefined) {
      comparisonCount += 1
      const mismatch = firstEventlogPrefixMismatch(previous.events, confirmed)
      if (mismatch !== undefined) {
        return failedVerdict(
          oracle,
          [previous.recordIndex, record.index],
          `${selectedComponents.get(observation.key)} did not preserve its confirmed Eventlog prefix at position ${mismatch.position}: previous ${mismatch.expected}, observed ${mismatch.observed}`,
        )
      }
    }
    previousByComponent.set(observation.key, { events: confirmed, recordIndex: record.index })
  }

  const insufficient = [...selectedComponents].flatMap(([key, label]) => {
    const count = observationCountByComponent.get(key) ?? 0
    return count < 2 ? [`${label} (${count})`] : []
  })
  if (insufficient.length > 0) {
    return failedVerdict(
      oracle,
      evidence,
      `Confirmed Eventlog prefix has insufficient evidence; expected at least two complete observations for: ${insufficient.join(', ')}`,
    )
  }

  return passedVerdict(
    oracle,
    evidence,
    `${comparisonCount} retained confirmed Eventlog transitions preserved their prefixes across ${selectedComponents.size} components${repeatedEncodingCount === 0 ? '' : `; coalesced ${repeatedEncodingCount} repeated same-position encodings`}`,
  )
}

type EventlogConvergenceOracle = Extract<ScenarioOracle, { readonly _tag: 'eventlog-convergence' }>

export interface EventlogCaptureEvidence {
  readonly backend: {
    readonly recordIndex: number
    readonly head: string
    readonly events: ReadonlyArray<ObservedEvent>
  }
  readonly participants: ReadonlyMap<string, ParticipantEventlogEvidence>
}

export interface ParticipantEventlogEvidence {
  readonly recordIndex: number
  readonly observation: ComponentSyncObservation
}

export interface EventlogCaptureAccumulator {
  backend?: EventlogCaptureEvidence['backend']
  readonly participants: Map<string, ParticipantEventlogEvidence>
}

const evaluateEventlogConvergenceOracle = (
  oracle: EventlogConvergenceOracle,
  trace: ReadonlyArray<ScenarioTraceRecord>,
): OracleVerdict => {
  const evidence = latestCompleteEventlogCapture(trace, oracle.participants)
  if (evidence === undefined) {
    return failedVerdict(
      oracle,
      [],
      'Eventlog convergence has insufficient evidence: no complete backend and participant observation capture',
    )
  }

  const backendEvents = evidence.backend.events.filter((event) => event.disposition === 'confirmed')
  const evidenceIndexes = [
    evidence.backend.recordIndex,
    ...oracle.participants.flatMap((participant) => {
      const participantEvidence = evidence.participants.get(participantKey(participant))
      return participantEvidence === undefined ? [] : [participantEvidence.recordIndex]
    }),
  ]

  for (const participant of oracle.participants) {
    const key = participantKey(participant)
    const participantEvidence = evidence.participants.get(key)
    if (participantEvidence === undefined) {
      return failedVerdict(oracle, evidenceIndexes, `Eventlog convergence has insufficient evidence for ${key}`)
    }

    const observation = participantEvidence.observation
    const settledAtBackendHead =
      observation.pendingCount === 0 &&
      globalPosition(observation.localHead) === globalPosition(evidence.backend.head) &&
      globalPosition(observation.upstreamHead) === globalPosition(evidence.backend.head)
    if (settledAtBackendHead === false) {
      return failedVerdict(
        oracle,
        evidenceIndexes,
        `${key} is not settled at authoritative backend head ${evidence.backend.head}`,
      )
    }

    const participantEvents = observation.events.filter((event) => event.disposition === 'confirmed')
    const mismatch = firstEventlogMismatch(backendEvents, participantEvents)
    if (mismatch !== undefined) {
      return failedVerdict(
        oracle,
        evidenceIndexes,
        `${key} diverged from the authoritative Eventlog at position ${mismatch.position}: expected ${mismatch.expected}, observed ${mismatch.observed}`,
      )
    }
  }

  return passedVerdict(
    oracle,
    evidenceIndexes,
    `All expected participants match the authoritative Eventlog through ${evidence.backend.head}`,
  )
}

const evaluateOperationHistoryOracle = (
  oracle: OperationHistoryOracle,
  trace: ReadonlyArray<ScenarioTraceRecord>,
): OracleVerdict => {
  const history = deriveScenarioOperationHistoryProjection(trace)
  const selected = oracle.operationIds.map((operationId) =>
    history.operations.find((operation) => operation.operationId === operationId),
  )
  const evidence = selected.flatMap((operation) =>
    operation === undefined
      ? []
      : [operation.invocationRecordIndex, operation.outcomeRecordIndex].filter(
          (index): index is number => index !== null,
        ),
  )
  const missing = oracle.operationIds.filter((_operationId, index) => selected[index] === undefined)
  if (missing.length > 0) {
    return failedVerdict(oracle, evidence, `Operation history omitted: ${missing.join(', ')}`)
  }
  const operations = selected.filter((operation) => operation !== undefined)
  const unacceptable = operations.filter(
    (operation) =>
      operation.status === 'pending' || (operation.status === 'indefinite' && oracle.allowIndefinite === false),
  )
  if (unacceptable.length > 0) {
    return failedVerdict(
      oracle,
      evidence,
      `Operation history has unacceptable outcomes: ${unacceptable.map((operation) => `${operation.operationId}=${operation.status}`).join(', ')}`,
    )
  }
  if (oracle.requireOverlap === true && deriveOverlappingScenarioOperationPairs(operations).length === 0) {
    return failedVerdict(oracle, evidence, 'Selected operations did not overlap')
  }
  return passedVerdict(
    oracle,
    evidence,
    `${operations.length} selected operations have terminal${oracle.allowIndefinite === true ? '' : ', non-indefinite'} outcomes${oracle.requireOverlap === true ? ' and overlapping invocation intervals' : ''}`,
  )
}

/** Resolves every named workload before creating participants and retains its deterministic expansion for the run. */
import {
  type ComponentSyncObservation,
  type ConfirmedEventlogPrefixOracle,
  type ObservedEvent,
  type OperationHistoryOracle,
  type OracleVerdict,
  type ParticipantSnapshot,
  participantKey,
  type ScenarioOracle,
  type ScenarioTraceRecord,
} from '../model.ts'
import {
  backendComponentKey,
  deriveOverlappingScenarioOperationPairs,
  deriveScenarioOperationHistoryProjection,
  leaderComponentKey,
  sessionComponentKey,
} from '../projection.ts'
import {
  canonicalConfirmedEvents,
  canonicalJson,
  failedVerdict,
  firstEventlogMismatch,
  firstEventlogPrefixMismatch,
  globalPosition,
  latestCompleteEventlogCapture,
  observedComponentEventlog,
  passedVerdict,
  readIds,
} from './eventlog.ts'
import type { TraceRecorder } from './trace-recorder.ts'
