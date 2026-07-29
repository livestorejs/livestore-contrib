export const validateExecution = (args: {
  scenario: ScenarioAst
  applicationId: string
  host: ParticipantHost
  execution: ExecutionConfiguration
}): Effect.Effect<void, ScenarioOperationError> => {
  try {
    // A caller can construct a value typed as ScenarioAst without using the
    // authoring constructor, so execution repeats its semantic validation.
    defineScenario(args.scenario)
  } catch (cause) {
    return Effect.fail(
      new ScenarioOperationError(
        'invalid-scenario',
        cause instanceof Error ? cause.message : `Invalid scenario: ${String(cause)}`,
      ),
    )
  }
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
  const oversizedClients = sessionsBeyondHostLimit({
    scenario: args.scenario,
    maximumSessionsPerClient: args.host.capabilities.maximumSessionsPerClient,
  })
  if (oversizedClients.length > 0) {
    return Effect.fail(
      new ScenarioOperationError(
        'capability-unavailable',
        `Host ${args.host.capabilities.profile} supports at most ${args.host.capabilities.maximumSessionsPerClient} session(s) per Client; requested: ${oversizedClients.map(({ clientId, requested }) => `${clientId} (${requested})`).join(', ')}`,
      ),
    )
  }
  const missing = deriveScenarioRequirements(args.scenario).filter((capability) => available.has(capability) === false)
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

export const makeScenarioArtifact = (input: {
  args: {
    scenario: ScenarioAst
    applicationId: string
    host: ParticipantHost
    options?: RunScenarioOptions
  }
  execution: ExecutionConfiguration
  runId: string
  trace: ReadonlyArray<ScenarioTraceRecord>
  verdicts: ReadonlyArray<OracleVerdict>
  snapshots: ReadonlyArray<ParticipantSnapshot>
  status: 'passed' | 'failed'
}): Effect.Effect<ScenarioRunArtifact> =>
  Schema.decodeUnknownEffect(ScenarioRunArtifact)({
    artifactVersion: scenarioArtifactVersion,
    descriptor: {
      runId: input.runId,
      scenarioId: input.args.scenario.id,
      scenarioVersion: input.args.scenario.version,
      traceVersion: scenarioTraceVersion,
      applicationId: input.args.applicationId,
      sourceRevision: input.args.options?.sourceRevision ?? 'working-tree',
      seed: input.args.scenario.seed,
      reproductionMode: 'seeded',
      execution: input.execution,
      capabilities: input.args.host.capabilities,
      componentVersions: input.args.host.componentVersions,
    },
    scenario: input.args.scenario,
    trace: input.trace,
    verdicts: input.verdicts,
    snapshots: input.snapshots,
    status: input.status,
  }).pipe(Effect.orDie)

export const describeHostError = (error: HostError): { readonly code: string; readonly message: string } => {
  if (error instanceof ScenarioOperationError) return { code: error.code, message: error.message }
  return {
    code: error._tag,
    message: error.note ?? formatUnknownFailure(error.cause),
  }
}

const formatUnknownFailure = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}
import { Effect, Schema } from '@livestore/utils/effect'

import { ScenarioOperationError } from '../application.ts'
import { deriveScenarioRequirements, sessionsBeyondHostLimit } from '../capabilities.ts'
import type { HostError, ParticipantHost } from '../host.ts'
import {
  defineScenario,
  type ExecutionConfiguration,
  type OracleVerdict,
  type ParticipantSnapshot,
  type ScenarioAst,
  scenarioArtifactVersion,
  ScenarioRunArtifact,
  type ScenarioTraceRecord,
  scenarioTraceVersion,
} from '../model.ts'
import type { RunScenarioOptions } from '../runner.ts'
