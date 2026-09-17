import { Schema } from '@livestore/utils/effect'

import {
  BackendObservation,
  ComponentSyncObservation,
  type ObservedEvent,
  OracleVerdict,
  type ScenarioTraceRecord,
} from '../model.ts'

export const ProjectedSession = Schema.Struct({
  sessionId: Schema.String,
  lifecycle: Schema.Literals(['declared', 'created', 'stopped']),
  health: Schema.Literals(['unknown', 'healthy', 'failed']),
  sync: Schema.NullOr(ComponentSyncObservation),
})
export type ProjectedSession = typeof ProjectedSession.Type

export const ProjectedClient = Schema.Struct({
  clientId: Schema.String,
  lifecycle: Schema.Literals(['declared', 'created']),
  health: Schema.Literals(['unknown', 'healthy', 'degraded', 'failed']),
  connected: Schema.NullOr(Schema.Boolean),
  leader: Schema.NullOr(ComponentSyncObservation),
  sessions: Schema.Array(ProjectedSession),
})
export type ProjectedClient = typeof ProjectedClient.Type

export const ObservedSystemState = Schema.Struct({
  cursorIndex: Schema.Finite,
  runStatus: Schema.Literals(['not-started', 'running', 'passed', 'failed']),
  backend: Schema.NullOr(BackendObservation),
  clients: Schema.Array(ProjectedClient),
  verdicts: Schema.Array(OracleVerdict),
})
export type ObservedSystemState = typeof ObservedSystemState.Type

export interface EventTimelineMarker {
  readonly recordIndex: number
  readonly componentKey: string
  readonly event: ObservedEvent
  readonly captureId: string
  readonly captureIndex: number
  readonly calibratedTime: ScenarioTraceRecord['calibratedTime']
}

export interface TraceCapture {
  readonly captureId: string
  readonly captureIndex: number
  readonly firstRecordIndex: number
  readonly lastRecordIndex: number
  readonly recordIndexes: ReadonlyArray<number>
}

export type ConnectivityBoundaryEvidence = 'explicit-transition' | 'first-observed'

export interface ConnectivityInterval {
  readonly clientId: string
  readonly startRecordIndex: number
  readonly endRecordIndex: number | null
  readonly startEvidence: ConnectivityBoundaryEvidence
  readonly endEvidence: ConnectivityBoundaryEvidence | null
}

export interface LaneActivityInterval {
  readonly componentKey: string
  readonly startRecordIndex: number
  readonly endRecordIndex: number | null
}

export interface RuntimeFailureInterval {
  readonly componentKey: string
  readonly clientId: string
  readonly sessionId: string | null
  readonly startRecordIndex: number
  readonly endRecordIndex: number | null
  readonly recordIndexes: ReadonlyArray<number>
  readonly summary: string
}

export type PlaybackMomentKind =
  | 'run'
  | 'annotation'
  | 'action'
  | 'action-sequence'
  | 'topology'
  | 'connectivity'
  | 'lifecycle'
  | 'capture'
  | 'settlement'
  | 'wait'
  | 'failure'

export interface PlaybackMoment {
  readonly momentIndex: number
  readonly recordIndex: number
  readonly recordIndexes: ReadonlyArray<number>
  readonly captureId: string | null
  readonly kind: PlaybackMomentKind
  readonly label: string
  readonly summary: string
}

export interface ExplicitCausalEdge {
  readonly fromRecordIndex: number
  readonly toRecordIndex: number
}

export interface ScenarioOperationHistoryEntry {
  readonly operationId: string
  readonly family: ScenarioOperationHistoryFamily
  readonly participant: string | null
  readonly invocationRecordIndex: number
  readonly outcomeRecordIndex: number | null
  readonly status: 'pending' | 'succeeded' | 'definite-failure' | 'indefinite'
}

export type ScenarioOperationHistoryFamily =
  | 'client-create'
  | 'application-action'
  | 'action-sequence'
  | 'connectivity'
  | 'backend-availability'
  | 'session-lifecycle'
  | 'client-lifecycle'
  | 'settlement'
  | 'wait'

export interface ScenarioOperationHistoryCoverage {
  readonly includedFamilies: ReadonlyArray<ScenarioOperationHistoryFamily>
  readonly excludedInteractions: ReadonlyArray<'system-observation' | 'sync-observation' | 'state-inspection'>
  readonly concurrencyBoundary: 'instruction-to-control-outcome'
}

export interface ScenarioOperationHistoryProjection {
  readonly coverage: ScenarioOperationHistoryCoverage
  readonly operations: ReadonlyArray<ScenarioOperationHistoryEntry>
}

export interface OverlappingScenarioOperationPair {
  readonly leftOperationId: string
  readonly rightOperationId: string
}

export const scenarioOperationHistoryCoverage: ScenarioOperationHistoryCoverage = {
  includedFamilies: [
    'client-create',
    'application-action',
    'action-sequence',
    'connectivity',
    'backend-availability',
    'session-lifecycle',
    'client-lifecycle',
    'settlement',
    'wait',
  ],
  excludedInteractions: ['system-observation', 'sync-observation', 'state-inspection'],
  concurrencyBoundary: 'instruction-to-control-outcome',
}

export interface TimeScalePoint {
  readonly timeMs: number
  readonly position: number
}

export interface CompressedTimeGap {
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly startPosition: number
  readonly endPosition: number
}

export interface AdaptiveTimeLayout {
  readonly points: ReadonlyArray<TimeScalePoint>
  readonly compressedGaps: ReadonlyArray<CompressedTimeGap>
}
