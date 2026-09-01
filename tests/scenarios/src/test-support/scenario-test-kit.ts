export { readFileSync } from 'node:fs'
export { gunzipSync } from 'node:zlib'

export { expect } from 'vitest'

export { Vitest } from '@livestore/utils-dev/node-vitest'
export { Deferred, Effect, Exit, Schema } from '@livestore/utils/effect'

export {
  participantHostFailure,
  type ParticipantHostFailureCode,
  type ScenarioOperationFailureOutcome,
} from '../application/definition.ts'
export { makeMockScenarioBackend } from '../backends.ts'
export { browserHostCapabilities } from '../profiles/browser/host.ts'
export { deriveScenarioRequirements } from '../capabilities.ts'
export { hotelBookingApplication } from '../corpus/applications/hotel-booking.ts'
export { todoApplication } from '../corpus/applications/todo.ts'
export {
  browserMultiSessionRecovery,
  concurrentHotelBooking,
  largePayloadRecovery,
  manyWriterConvergence,
  offlineWriterRecovery,
  pendingTailRecovery,
} from '../corpus/scenarios/registry.ts'
export { backendOutageRecovery } from './scenarios/backend-outage-recovery.ts'
export { lateClientCatchUp } from './scenarios/late-client-catch-up.ts'
export { makeSeededTodoActions, seededTodoActions } from './scenarios/seeded-todo-actions.ts'
export type { ParticipantHost } from '../profiles/contract.ts'
export { inProcessHostCapabilities, makeInProcessHost } from '../profiles/in-process/host.ts'
export {
  defineScenario,
  scenarioVersion,
  terminalStabilizationParticipants,
  type ActionSequenceStep,
  deriveScenarioTopology,
  type HostSystemObservation,
  type ObservedEvent,
  ScenarioRunArtifact,
  type ScenarioTraceRecord,
} from '../model.ts'
export { processHostCapabilities } from '../profiles/process/host.ts'
export {
  deriveAdaptiveTimeLayout,
  deriveConnectivityIntervals,
  deriveEventTimeline,
  deriveExplicitCausalEdges,
  deriveInFlightScenarioOperationIds,
  deriveLaneActivityIntervals,
  deriveOverlappingScenarioOperationPairs,
  derivePlaybackMoments,
  deriveRuntimeFailureIntervals,
  deriveScenarioOperationHistory,
  deriveScenarioOperationHistoryProjection,
  deriveTraceCaptures,
  projectAdaptiveTime,
  projectTraceAt,
} from '../projection.ts'
export {
  runBrowserLocalSyncCfScenario,
  runInProcessLocalSyncCfScenario,
  runInProcessScenario,
  runProcessLocalSyncCfScenario,
  runScenario,
} from '../runner.ts'
