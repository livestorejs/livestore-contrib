import {
  type HostObservationOccurrence,
  type ScenarioTracePayload,
  type ScenarioTraceRecord,
  scenarioTraceVersion,
} from '../model.ts'

type TraceInput = {
  readonly origin: ScenarioTraceRecord['origin']
  readonly payload: ScenarioTracePayload
  readonly correlationId?: string
  readonly causationId?: string
  readonly clientId?: string
  readonly sessionId?: string
  readonly phaseId?: string
  readonly captureId?: string
  readonly evidence?: ScenarioTraceRecord['evidence']
  readonly causedBy?: ReadonlyArray<number>
  readonly occurrence?: HostObservationOccurrence
}

export interface TraceRecorder {
  (input: TraceInput): ScenarioTraceRecord
  readonly nextCaptureId: (reason: string) => string
  readonly instructionIndex: (correlationId: string) => ReadonlyArray<number>
  readonly pendingOperationIds: (excluding?: ReadonlyArray<string>) => ReadonlyArray<string>
}

export const makeTraceRecorder = (args: {
  runId: string
  trace: ScenarioTraceRecord[]
  readLogicalTime: () => number
}): TraceRecorder => {
  let index = 0
  let captureIndex = 0
  const startedAt = performance.now()
  const instructionByCorrelation = new Map<string, number>()
  const pendingOperationIds = new Set<string>()
  const record = (input: TraceInput): ScenarioTraceRecord => {
    const coordinatorReceiptMonotonicMs = performance.now() - startedAt
    const occurrence = input.occurrence
    const localMonotonicMs = occurrence?.reading.localMonotonicMs ?? coordinatorReceiptMonotonicMs
    const causedBy =
      input.causedBy ??
      (input.origin === 'acknowledgement' && input.correlationId !== undefined
        ? [instructionByCorrelation.get(input.correlationId)].filter((value): value is number => value !== undefined)
        : [])
    const traceRecord: ScenarioTraceRecord = {
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
      captureId: input.captureId ?? null,
      evidence: input.evidence ?? evidenceForOrigin(input.origin),
      emitterId: occurrence?.reading.emitterId ?? 'scenario-controller',
      localSequence: occurrence?.reading.localSequence ?? index,
      localMonotonicMs,
      coordinatorReceiptMonotonicMs,
      calibratedTime:
        occurrence === undefined
          ? {
              earliestMs: coordinatorReceiptMonotonicMs,
              latestMs: coordinatorReceiptMonotonicMs,
              calibrationId: 'scenario-controller-clock',
            }
          : {
              earliestMs: occurrence.controllerBeforeMonotonicMs - startedAt,
              latestMs: occurrence.controllerAfterMonotonicMs - startedAt,
              calibrationId: occurrence.calibrationId,
            },
      causedBy: [...causedBy],
      payload: input.payload,
    }
    if (input.origin === 'instruction' && input.correlationId !== undefined) {
      instructionByCorrelation.set(input.correlationId, index)
      pendingOperationIds.add(input.correlationId)
    } else if (
      input.correlationId !== undefined &&
      (input.origin === 'acknowledgement' || input.payload._tag === 'operation.outcome')
    ) {
      pendingOperationIds.delete(input.correlationId)
    }
    index += 1
    args.trace.push(traceRecord)
    return traceRecord
  }
  return Object.assign(record, {
    nextCaptureId: (reason: string) => `${args.runId}:capture:${captureIndex++}:${reason}`,
    instructionIndex: (correlationId: string) => {
      const instructionIndex = instructionByCorrelation.get(correlationId)
      return instructionIndex === undefined ? [] : [instructionIndex]
    },
    pendingOperationIds: (excluding: ReadonlyArray<string> = []) => {
      const excluded = new Set(excluding)
      return [...pendingOperationIds].filter((operationId) => excluded.has(operationId) === false)
    },
  })
}

const evidenceForOrigin = (origin: ScenarioTraceRecord['origin']): ScenarioTraceRecord['evidence'] => {
  switch (origin) {
    case 'instruction':
      return 'instruction-sent'
    case 'acknowledgement':
      return 'acknowledgement-received'
    case 'verdict':
      return 'verdict'
    case 'observation':
      return 'controller-event'
  }
}
