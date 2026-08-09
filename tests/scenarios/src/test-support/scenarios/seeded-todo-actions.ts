import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { sharedScenarioHelpers } from '../../corpus/scenario-helpers.ts'
import { compileScenarioYamlFileSync } from '../../yaml/file.ts'
import { composeScenarioHelpers } from '../../yaml/helpers.ts'
import localHelpers from './seeded-todo-actions.helpers.ts'

const source = new URL('./seeded-todo-actions.scenario.yaml', import.meta.url)

export const makeSeededTodoActions = (seed = 1445) =>
  compileScenarioYamlFileSync(source, {
    applications: scenarioApplications,
    helpers: composeScenarioHelpers([
      { source: 'shared Scenario helper catalogue', helpers: sharedScenarioHelpers },
      { source: 'seeded-todo-actions.helpers.ts', helpers: localHelpers },
    ]),
    seed,
  })

export const seededTodoActions = makeSeededTodoActions()
export default seededTodoActions
