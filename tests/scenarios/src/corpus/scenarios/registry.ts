import type { ScenarioAst } from '../../model.ts'
import { backendOutageRecovery } from './backend-outage-recovery.ts'
import { browserMultiSessionRecovery } from './browser-multi-session-recovery.ts'
import { concurrentHotelBooking } from './concurrent-hotel-booking.ts'
import { largePayloadRecovery } from './large-payload-recovery.ts'
import { lateClientCatchUp } from './late-client-catch-up.ts'
import { manyWriterConvergence } from './many-writer-convergence.ts'
import { offlineWriterRecovery } from './offline-writer-recovery.ts'
import { pendingPushBoundary } from './pending-push-boundary.ts'
import { pendingTailRecovery } from './pending-tail-recovery.ts'
import { reconnectFlapping } from './reconnect-flapping.ts'
import { seededTodoWorkload } from './seeded-todo-workload.ts'
import { sharedTodoWorkday } from './shared-todo-workday.ts'

export const scenarioCorpus: ReadonlyArray<ScenarioAst> = [
  backendOutageRecovery,
  browserMultiSessionRecovery,
  concurrentHotelBooking,
  largePayloadRecovery,
  lateClientCatchUp,
  manyWriterConvergence,
  offlineWriterRecovery,
  pendingPushBoundary,
  pendingTailRecovery,
  reconnectFlapping,
  seededTodoWorkload,
  sharedTodoWorkday,
]

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
