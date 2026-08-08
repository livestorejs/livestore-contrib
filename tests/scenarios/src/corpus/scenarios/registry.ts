import type { ScenarioAst } from '../../model.ts'
import { browserMultiSessionRecovery } from './retained/examples/browser-multi-session-recovery.ts'
import { offlineWriterRecovery } from './retained/examples/offline-writer-recovery.ts'
import { concurrentHotelBooking } from './retained/findings/concurrent-hotel-booking.ts'
import { largePayloadRecovery } from './retained/findings/large-payload-recovery.ts'
import { manyWriterConvergence } from './retained/findings/many-writer-convergence.ts'
import { pendingTailRecovery } from './retained/findings/pending-tail-recovery.ts'

export interface RetainedScenarioEntry {
  readonly kind: 'example' | 'finding'
  readonly findingId?: 'SF-01' | 'SF-02' | 'SF-03' | 'SF-04'
  readonly scenario: ScenarioAst
}

export const retainedScenarioCatalog: ReadonlyArray<RetainedScenarioEntry> = [
  { kind: 'example', scenario: offlineWriterRecovery },
  { kind: 'example', scenario: browserMultiSessionRecovery },
  { kind: 'finding', findingId: 'SF-01', scenario: concurrentHotelBooking },
  { kind: 'finding', findingId: 'SF-02', scenario: pendingTailRecovery },
  { kind: 'finding', findingId: 'SF-03', scenario: manyWriterConvergence },
  { kind: 'finding', findingId: 'SF-04', scenario: largePayloadRecovery },
]

export const scenarioCorpus: ReadonlyArray<ScenarioAst> = retainedScenarioCatalog.map(({ scenario }) => scenario)

const scenariosById: ReadonlyMap<string, ScenarioAst> = new Map(
  scenarioCorpus.map((scenario) => [scenario.id, scenario]),
)

if (scenariosById.size !== scenarioCorpus.length) {
  throw new Error('Scenario IDs must be unique')
}

export const getScenario = (scenarioId: string): ScenarioAst => {
  const scenario = scenariosById.get(scenarioId)
  if (scenario !== undefined) return scenario
  throw new Error(`Unknown scenario '${scenarioId}'. Expected: ${scenarioCorpus.map(({ id }) => id).join(', ')}`)
}
