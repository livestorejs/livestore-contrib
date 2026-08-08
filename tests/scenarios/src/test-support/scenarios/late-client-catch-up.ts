import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { compileScenarioFileSync } from '../../dsl/file.ts'

export const lateClientCatchUp = compileScenarioFileSync(new URL('./late-client-catch-up.scenario', import.meta.url), {
  applications: scenarioApplications,
})
