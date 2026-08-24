import { runE2EMatrix } from './harness.ts'
import type { LiveManifest } from './live-manifest.ts'
import {
  aggregateVerdict,
  liveWriteConfirmation,
  makeMarker,
  makeRunId,
  opaqueHash,
  scenarioMatrix,
  type RunReceipt,
} from './model.ts'
import type { E2ETransport } from './transport.ts'

export interface LiveRunnerInput {
  readonly manifest: LiveManifest | undefined
  readonly confirmation: string | undefined
  readonly transport: E2ETransport | undefined
  /** True only while the named human is actively completing the interaction checklist. */
  readonly humanAssisted: boolean
}
const unrunReceipt = (): RunReceipt => {
  const runId = makeRunId()
  const startedAt = new Date().toISOString()
  const scenarios = scenarioMatrix.map((scenario) => ({
    scenario: scenario.id,
    executor: scenario.executor,
    verdict: 'UNRUN' as const,
    reason: 'prerequisite-missing' as const,
    targetHash: opaqueHash('unconfigured-staging-target'),
    markerHash: opaqueHash(makeMarker(runId, scenario.id)),
    artifactHashes: [],
    cleanup: {
      sourceMessage: 'not-needed' as const,
      thread: 'not-needed' as const,
      response: 'not-needed' as const,
    },
  }))

  return {
    schemaVersion: 1,
    runId,
    environment: 'staging',
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios,
    verdict: aggregateVerdict(scenarios),
  }
}

/**
 * The only staging write gate. Configuration loading and approved secret
 * injection happen outside this function; absent prerequisites produce UNRUN.
 */
export const runLiveStaging = async (input: LiveRunnerInput): Promise<RunReceipt> => {
  if (input.manifest === undefined || input.transport === undefined || input.confirmation !== liveWriteConfirmation) {
    return unrunReceipt()
  }

  return runE2EMatrix({
    environment: 'staging',
    target: input.manifest.target,
    transport: input.transport,
    allowHumanAssisted: input.humanAssisted,
  })
}
