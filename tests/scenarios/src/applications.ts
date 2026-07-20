import { todoApplication } from './fixtures/todo-application.ts'

/** Runtime registry used by serialized participant hosts. */
export const getScenarioApplication = (applicationId: string) => {
  if (applicationId === todoApplication.id) return todoApplication
  throw new Error(`Unknown scenario application: ${applicationId}`)
}
