import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { compileScenarioYamlFileSync } from '../../yaml/file.ts'

const source = new URL('./seeded-todo-actions.scenario.yaml', import.meta.url)

export const makeSeededTodoActions = (seed = 1445) =>
  compileScenarioYamlFileSync(source, { applications: scenarioApplications, seed })

export const seededTodoActions = makeSeededTodoActions()
export default seededTodoActions
