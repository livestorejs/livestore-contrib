import { normalizeScenario } from '../../scenario.ts'
import source from './seeded-todo-actions.scenario.ts'

export const makeSeededTodoActions = (seed = 1445) => normalizeScenario(source, { id: 'seeded-todo-actions', seed })

export const seededTodoActions = makeSeededTodoActions()
export default seededTodoActions
