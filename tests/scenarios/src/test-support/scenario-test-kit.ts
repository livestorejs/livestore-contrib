export { readFileSync } from 'node:fs'
export { gunzipSync } from 'node:zlib'

export { expect } from 'vitest'

export { Vitest } from '@livestore/utils-dev/node-vitest'
export { Deferred, Effect, Exit, Schema } from '@livestore/utils/effect'

export {
  participantHostFailure,
  type ParticipantHostFailureCode,
  type ScenarioOperationFailureOutcome,
} from '../application.ts'
export { makeMockScenarioBackend } from '../backends.ts'
export { browserHostCapabilities } from '../browser/browser-host.ts'
export { deriveScenarioRequirements } from '../capabilities.ts'
export { backendOutageRecovery } from '../corpus/backend-outage-recovery.ts'
export { browserMultiSessionRecovery } from '../corpus/browser-multi-session-recovery.ts'
export { lateClientCatchUp } from '../corpus/late-client-catch-up.ts'
export { offlineWriterRecovery } from '../corpus/offline-writer-recovery.ts'
export { seededTodoWorkload } from '../corpus/seeded-todo-workload.ts'
export { sharedTodoWorkday } from '../corpus/shared-todo-workday.ts'
export { todoApplication } from '../fixtures/todo-application.ts'
export { inProcessHostCapabilities, makeInProcessHost, type ParticipantHost } from '../host.ts'
export {
  defineScenario,
  deriveScenarioTopology,
  type HostSystemObservation,
  type ObservedEvent,
  ScenarioRunArtifact,
  type ScenarioTraceRecord,
} from '../model.ts'
export { processHostCapabilities } from '../process/process-host.ts'
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
