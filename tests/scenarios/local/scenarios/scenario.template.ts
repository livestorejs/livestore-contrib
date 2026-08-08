import { todoApplication } from '../../src/corpus/applications/todo.ts'
import { defineScenario } from '../../src/model.ts'

const client = { clientId: 'client-a', sessionId: 'session-a' } as const

export default defineScenario({
  version: 2,
  id: 'replace-me',
  description: 'Describe the behavior or hypothesis this Scenario exercises.',
  tags: ['local'],
  seed: 1,
  applicationId: todoApplication.id,
  requires: [],
  topology: {
    storeId: 'scenario-replace-me',
    clients: [{ id: client.clientId, sessions: [client.sessionId], initiallyConnected: true }],
  },
  phases: [],
  oracles: [],
})
