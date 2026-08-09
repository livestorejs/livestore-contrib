import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { sharedScenarioHelpers } from '../../corpus/scenario-helpers.ts'
import { compileScenarioYamlFileSync } from '../../yaml/file.ts'

export const lateClientCatchUp = compileScenarioYamlFileSync(
  new URL('./late-client-catch-up.scenario.yaml', import.meta.url),
  {
    applications: scenarioApplications,
    helpers: sharedScenarioHelpers,
  },
)
