import { runE2EMatrix } from './harness.ts'
import type { LiveManifest } from './live-manifest.ts'
import {
  aggregateVerdict,
  fullScenarioSelection,
  liveWriteConfirmation,
  makeMarker,
  makeRunId,
  opaqueHash,
  scenarioIdsForSelection,
  scenarioMatrix,
  type RunReceipt,
  type ScenarioSelection,
} from './model.ts'
import type { E2ETransport } from './transport.ts'

export interface LiveRunnerInput {
  readonly manifest: LiveManifest | undefined
  readonly confirmation: string | undefined
  readonly transport: E2ETransport | undefined
  readonly selection?: ScenarioSelection
  /** True only while the named human is actively completing the interaction checklist. */
  readonly humanAssisted: boolean
}
const unrunReceipt = (selection: ScenarioSelection): RunReceipt => {
  const runId = makeRunId()
  const startedAt = new Date().toISOString()
  const selectedScenarioIds = new Set(scenarioIdsForSelection(selection))
  const scenarios = scenarioMatrix.map((scenario) => ({
    scenario: scenario.id,
    executor: scenario.executor,
    verdict: 'UNRUN' as const,
    reason: selectedScenarioIds.has(scenario.id) === true ? ('prerequisite-missing' as const) : ('not-selected' as const),
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
  const selection = input.selection ?? fullScenarioSelection
  if (input.manifest === undefined || input.transport === undefined || input.confirmation !== liveWriteConfirmation) {
    return unrunReceipt(selection)
  }

  return runE2EMatrix({
    environment: 'staging',
    target: input.manifest.target,
    transport: input.transport,
    selection,
    allowHumanAssisted: input.humanAssisted,
  })
}
