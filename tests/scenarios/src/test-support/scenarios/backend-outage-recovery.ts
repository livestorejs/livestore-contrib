import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { compileScenarioFileSync } from '../../dsl/file.ts'

export const backendOutageRecovery = compileScenarioFileSync(
  new URL('./backend-outage-recovery.scenario', import.meta.url),
  { applications: scenarioApplications },
)
