import { scenarioApplications } from '../../corpus/applications/registry.ts'
import { compileScenarioFileSync } from '../../dsl/file.ts'

const source = new URL('./seeded-todo-actions.scenario', import.meta.url)

export const makeSeededTodoActions = (seed = 1445) =>
  compileScenarioFileSync(source, { applications: scenarioApplications, seed })

export const seededTodoActions = makeSeededTodoActions()
export default seededTodoActions
