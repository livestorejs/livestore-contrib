import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { compileScenarioYamlFileSync } from '../../yaml/file.ts'

export const backendOutageRecovery = compileScenarioYamlFileSync(
  new URL('./backend-outage-recovery.scenario.yaml', import.meta.url),
  { applications: scenarioApplications },
)
