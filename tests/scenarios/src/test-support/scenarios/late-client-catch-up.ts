import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { sharedScenarioHelpers } from '../../corpus/scenario-helpers/shared.ts'
import { compileScenarioYamlFileSync } from '../../yaml/file.ts'
import { composeScenarioHelpers } from '../../yaml/helpers.ts'
import localHelpers from './late-client-catch-up.helpers.ts'

export const lateClientCatchUp = compileScenarioYamlFileSync(
  new URL('./late-client-catch-up.scenario.yaml', import.meta.url),
  {
    applications: scenarioApplications,
    helpers: composeScenarioHelpers([
      { source: 'shared Scenario helper catalogue', helpers: sharedScenarioHelpers },
      { source: 'late-client-catch-up.helpers.ts', helpers: localHelpers },
    ]),
  },
)
