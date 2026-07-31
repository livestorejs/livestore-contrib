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
export { backendOutageRecovery } from '../corpus/scenarios/backend-outage-recovery.ts'
export { browserMultiSessionRecovery } from '../corpus/scenarios/browser-multi-session-recovery.ts'
export { concurrentHotelBooking } from '../corpus/scenarios/concurrent-hotel-booking.ts'
export { lateClientCatchUp } from '../corpus/scenarios/late-client-catch-up.ts'
export { largePayloadRecovery } from '../corpus/scenarios/large-payload-recovery.ts'
export { manyWriterConvergence } from '../corpus/scenarios/many-writer-convergence.ts'
export { offlineWriterRecovery } from '../corpus/scenarios/offline-writer-recovery.ts'
export { pendingPushBoundary } from '../corpus/scenarios/pending-push-boundary.ts'
export { pendingTailRecovery } from '../corpus/scenarios/pending-tail-recovery.ts'
export { reconnectFlapping } from '../corpus/scenarios/reconnect-flapping.ts'
export { seededTodoWorkload } from '../corpus/scenarios/seeded-todo-workload.ts'
export { sharedTodoWorkday } from '../corpus/scenarios/shared-todo-workday.ts'
export type { ParticipantHost } from '../profiles/contract.ts'
export { inProcessHostCapabilities, makeInProcessHost } from '../profiles/in-process/host.ts'
export {
  defineScenario,
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
