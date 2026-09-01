import type { ScenarioTraceRecord } from '../model.ts'
import { operationFamily } from './system-state.ts'
import {
  type ExplicitCausalEdge,
  type OverlappingScenarioOperationPair,
  type ScenarioOperationHistoryEntry,
  type ScenarioOperationHistoryProjection,
  scenarioOperationHistoryCoverage,
} from './types.ts'

/** Returns only causal relationships explicitly retained by the trace protocol. */
export const deriveExplicitCausalEdges = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<ExplicitCausalEdge> => {
  const recordIndexes = new Set(trace.map((record) => record.index))
  return trace.flatMap((record) =>
    record.causedBy
      .filter((cause) => recordIndexes.has(cause))
      .map((cause) => ({ fromRecordIndex: cause, toRecordIndex: record.index })),
  )
}

/**
 * Projects runner instructions and their retained outcomes without claiming a
 * complete concurrent history or inventing boundaries absent from the trace.
 */
export const deriveScenarioOperationHistory = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
): ReadonlyArray<ScenarioOperationHistoryEntry> => {
  const outcomes = new Map<
    string,
    { readonly recordIndex: number; readonly status: ScenarioOperationHistoryEntry['status'] }
  >()
  for (const record of trace) {
    if (record.correlationId === null) continue
    if (record.origin === 'acknowledgement') {
      outcomes.set(record.correlationId, { recordIndex: record.index, status: 'succeeded' })
    } else if (record.payload._tag === 'operation.outcome') {
      outcomes.set(record.correlationId, { recordIndex: record.index, status: record.payload.status })
    }
  }

  return trace.flatMap((record) => {
    if (record.origin !== 'instruction' || record.correlationId === null) return []
    const family = operationFamily(record.payload)
    if (family === undefined) return []
    const outcome = outcomes.get(record.correlationId)
    return [
      {
        operationId: record.correlationId,
        family,
        participant:
          record.clientId === null
            ? null
            : record.sessionId === null
              ? record.clientId
              : `${record.clientId}/${record.sessionId}`,
        invocationRecordIndex: record.index,
        outcomeRecordIndex: outcome?.recordIndex ?? null,
        status: outcome?.status ?? 'pending',
      },
    ]
  })
}

export const deriveScenarioOperationHistoryProjection = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
): ScenarioOperationHistoryProjection => ({
  coverage: scenarioOperationHistoryCoverage,
  operations: deriveScenarioOperationHistory(trace),
})

export const deriveOverlappingScenarioOperationPairs = (
  operations: ReadonlyArray<ScenarioOperationHistoryEntry>,
): ReadonlyArray<OverlappingScenarioOperationPair> =>
  operations.flatMap((left, leftIndex) =>
    operations.slice(leftIndex + 1).flatMap((right) => {
      const leftOutcome = left.outcomeRecordIndex ?? Number.POSITIVE_INFINITY
      const rightOutcome = right.outcomeRecordIndex ?? Number.POSITIVE_INFINITY
      return left.invocationRecordIndex < rightOutcome && right.invocationRecordIndex < leftOutcome
        ? [{ leftOperationId: left.operationId, rightOperationId: right.operationId }]
        : []
    }),
  )

/** Returns operation IDs whose retained instruction has no outcome at this trace prefix. */
export const deriveInFlightScenarioOperationIds = (
  trace: ReadonlyArray<ScenarioTraceRecord>,
  excluding: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const excluded = new Set(excluding)
  return deriveScenarioOperationHistory(trace)
    .filter((operation) => operation.status === 'pending' && excluded.has(operation.operationId) === false)
    .map((operation) => operation.operationId)
}
