import { expect, it } from 'vitest'

import { fetchLiveDeploymentIdentity, parseLiveDeploymentIdentity } from './deploy-preflight.ts'

const workerName = 'discordbot-discordbot-staging-fzb2yrs5oh7y4ttr'
const namespaceId = '9fca2fc956e8417c878f89fac50ea207'
const settingsPayload = {
  success: true,
  result: {
    bindings: [
      {
        type: 'durable_object_namespace',
        name: 'BotState',
        class_name: 'BotState',
        namespace_id: namespaceId,
      },
    ],
  },
}

it('extracts the live BotState namespace from Worker settings', () => {
  expect(parseLiveDeploymentIdentity(settingsPayload, workerName)).toEqual({
    workerName,
    botStateNamespaceId: namespaceId,
  })
})

it('fails closed when Worker settings omit the BotState namespace', () => {
  expect(() => parseLiveDeploymentIdentity({ success: true, result: { bindings: [] } }, workerName))
    .toThrow(/no BotState Durable Object namespace/)
})

it('reads identity through the Cloudflare settings endpoint', async () => {
  let requestedUrl: string | undefined
  const observed = await fetchLiveDeploymentIdentity({
    accountId: 'account-id',
    apiToken: 'secret-token',
    workerName,
    fetchImpl: async (input) => {
      requestedUrl = input.toString()
      return Response.json(settingsPayload)
    },
  })
  expect(requestedUrl).toContain(`/workers/scripts/${workerName}/settings`)
  expect(observed.botStateNamespaceId).toBe(namespaceId)
})
