import { describe, expect, it } from 'vitest'

import { DiscordRestFailure } from '../../src/discord/rest-error-redaction.ts'
import { AdminControlFailure } from './admin-http-client.ts'
import { makeFakeWorld } from './fake-transport.ts'
import { runE2EMatrix } from './harness.ts'
import { BrokerOperationFailure } from './human-handoff.ts'
import { topicSentinel, type ResponseSnapshot, type Snowflake, type StagingTarget } from './model.ts'

const guildId = '111111111111111111' as Snowflake
const channelId = '222222222222222222' as Snowflake
const restrictedDocsChannelId = '333333333333333333' as Snowflake

const target: StagingTarget = {
  applicationId: '444444444444444444' as Snowflake,
  guildId,
  channelId,
  docsChannelIds: { public: channelId, restricted: restrictedDocsChannelId },
  allowedChannelIds: new Set([channelId, restrictedDocsChannelId]),
  requiredTopicSentinel: topicSentinel,
  pollIntervalMs: 1,
  timeoutMs: 4,
}

describe('Discord bot composed E2E tracer bullet', () => {
  it('passes every agreed flow through one black-box transport and cleans every owned artifact', async () => {
    const world = makeFakeWorld(target)
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport: world.transport,
      allowHumanAssisted: true,
    })

    expect(receipt.verdict).toBe('PASS')
    expect(receipt.scenarios).toHaveLength(11)
    expect(receipt.scenarios.every((scenario) => scenario.verdict === 'PASS')).toBe(true)
    expect(receipt.scenarios.map((scenario) => scenario.scenario)).toEqual([
      'automatic-eligible',
      'automatic-filtered',
      'automated-author-rejected',
      'operator-retroactive',
      'operator-idempotent',
      'operator-concurrent',
      'message-action-authorized',
      'message-action-denied',
      'docs-public',
      'docs-role-restricted',
      'docs-denied',
    ])

    expect(world.counts).toEqual({
      createdMessages: 8,
      createdThreads: 5,
      createdResponses: 7,
      deletedMessages: 8,
      deletedThreads: 5,
      deletedResponses: 7,
    })
    expect(world.messages.size).toBe(0)
    expect(world.threads.size).toBe(0)
    expect(world.responses.size).toBe(0)

    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(guildId)
    expect(serialized).not.toContain(channelId)
    expect(serialized).not.toContain(restrictedDocsChannelId)
    expect(serialized).not.toContain('How does LiveStore')
    expect(serialized).not.toContain('syncing work')
  })

  it('cleans source and thread while never attempting REST deletion of ephemeral replies', async () => {
    const world = makeFakeWorld(target)
    let responseDeletes = 0
    const transport = {
      ...world.transport,
      invokeMessageAction: async (request: Parameters<typeof world.transport.invokeMessageAction>[0]) => {
        const result = await world.transport.invokeMessageAction(request)
        const { id: _id, ...fields } = result.response
        return { ...result, response: { ...fields, ephemeral: true as const } }
      },
      invokeDocs: async (request: Parameters<typeof world.transport.invokeDocs>[0]) => {
        const result = await world.transport.invokeDocs(request)
        if (result._tag !== 'Denied') return result
        const responses = result.responses.map((response) => {
          const { id: _id, ...fields } = response
          return { ...fields, ephemeral: true as const }
        })
        return { ...result, responses: [responses[0]!, ...responses.slice(1)] as const }
      },
      deleteResponse: async () => {
        responseDeletes++
        throw new Error('ephemeral replies cannot be deleted over REST')
      },
    }
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      selection: {
        _tag: 'Scenarios',
        scenarios: ['message-action-authorized', 'message-action-denied', 'docs-denied'],
      },
      allowHumanAssisted: true,
    })
    const selected = receipt.scenarios.filter((scenario) => scenario.verdict !== 'UNRUN')
    expect(selected.map((scenario) => scenario.verdict)).toEqual(['PASS', 'PASS', 'PASS'])
    expect(selected.map((scenario) => scenario.cleanup.response)).toEqual(['not-needed', 'not-needed', 'not-needed'])
    expect(responseDeletes).toBe(0)
    expect(world.messages.size).toBe(0)
    expect(world.threads.size).toBe(0)
  })

  it('requires a valid non-local title when the staging target opts into AI-title proof', async () => {
    const aiTarget = { ...target, expectAiTitles: true }
    const selection = { _tag: 'Scenarios', scenarios: ['automatic-eligible'] } as const
    const aiWorld = makeFakeWorld(aiTarget)
    const aiReceipt = await runE2EMatrix({
      environment: 'fake',
      target: aiTarget,
      transport: aiWorld.transport,
      selection,
      allowHumanAssisted: true,
    })
    expect(aiReceipt.scenarios[0]?.verdict).toBe('PASS')
    expect(aiWorld.threads.size).toBe(0)

    for (const invalidName of ['local', '   ']) {
      const world = makeFakeWorld(target)
      const transport = {
        ...world.transport,
        findThreadForMessage: async (guildId: Snowflake, messageId: Snowflake) => {
          const thread = await world.transport.findThreadForMessage(guildId, messageId)
          return thread === undefined
            ? undefined
            : { ...thread, name: invalidName === 'local' ? thread.name : invalidName }
        },
      }
      const receipt = await runE2EMatrix({
        environment: 'fake',
        target: aiTarget,
        transport,
        selection,
        allowHumanAssisted: true,
      })
      expect(receipt.scenarios[0]).toMatchObject({
        verdict: 'FAIL',
        assertions: 'failed',
        reason: 'assertion-failed',
        cleanup: { thread: 'deleted', sourceMessage: 'deleted' },
      })
    }
  })

  it('deletes source-anchored docs response threads before deleting their responses', async () => {
    const world = makeFakeWorld(target, { threadResponses: true })
    const transport = {
      ...world.transport,
      deleteResponse: async (responseChannelId: Snowflake, responseId: Snowflake) => {
        expect(world.threads.has(responseId)).toBe(false)
        await world.transport.deleteResponse(responseChannelId, responseId)
      },
    }
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      allowHumanAssisted: true,
      selection: { _tag: 'Scenarios', scenarios: ['docs-public', 'docs-role-restricted', 'docs-denied'] },
    })

    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'PASS')).toHaveLength(3)
    expect(world.counts.createdThreads).toBe(5)
    expect(world.counts.deletedThreads).toBe(5)
    expect(world.counts.deletedResponses).toBe(5)
    expect(world.threads.size).toBe(0)
    expect(world.responses.size).toBe(0)
  })

  it('does not delete an unverified docs response thread or its source response', async () => {
    const world = makeFakeWorld(target, { threadResponses: true })
    const transport = {
      ...world.transport,
      findThreadForMessage: async (requestedGuildId: Snowflake, responseId: Snowflake) => {
        const thread = await world.transport.findThreadForMessage(requestedGuildId, responseId)
        return thread === undefined ? undefined : { ...thread, parentChannelId: channelId }
      },
    }
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      allowHumanAssisted: true,
      selection: { _tag: 'Scenarios', scenarios: ['docs-role-restricted'] },
    })

    expect(receipt.scenarios.find((scenario) => scenario.scenario === 'docs-role-restricted')).toMatchObject({
      verdict: 'FAIL',
      reason: 'cleanup-failed',
      cleanup: { thread: 'failed', response: 'failed' },
    })
    expect(world.counts.deletedThreads).toBe(0)
    expect(world.counts.deletedResponses).toBe(0)
    expect(world.threads.size).toBe(2)
    expect(world.responses.size).toBe(2)
  })

  it('reports human interaction lanes as UNRUN when no human executor participated', async () => {
    const world = makeFakeWorld(target)
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport: world.transport,
    })

    expect(receipt.verdict).toBe('UNRUN')
    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'PASS')).toHaveLength(4)
    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'UNRUN')).toHaveLength(7)
    expect(
      receipt.scenarios
        .filter((scenario) => scenario.verdict === 'UNRUN')
        .every((scenario) => scenario.reason === 'official-automation-unavailable'),
    ).toBe(true)
  })

  it('denies a target outside the manifest allowlist before any write', async () => {
    const world = makeFakeWorld(target)
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target: { ...target, allowedChannelIds: new Set() },
      transport: world.transport,
      allowHumanAssisted: true,
    })

    expect(receipt.verdict).toBe('FAIL')
    expect(receipt.scenarios.every((scenario) => scenario.reason === 'target-denied')).toBe(true)
    expect(world.counts.createdMessages).toBe(0)
    expect(world.counts.createdThreads).toBe(0)
    expect(world.counts.createdResponses).toBe(0)
  })

  it('refuses cleanup ownership for an uncorrelated thread', async () => {
    const world = makeFakeWorld(target)
    const unrelatedId = '999999999999999999' as Snowflake
    const transport = {
      ...world.transport,
      findThreadForMessage: async () => ({
        id: unrelatedId,
        name: 'Unrelated thread',
        guildId,
        parentChannelId: channelId,
        sourceMessageId: unrelatedId,
        marker: 'unrelated',
      }),
    }

    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      allowHumanAssisted: true,
    })
    const eligible = receipt.scenarios.find((scenario) => scenario.scenario === 'automatic-eligible')

    expect(eligible?.verdict).toBe('FAIL')
    expect(eligible?.reason).toBe('assertion-failed')
    expect(eligible?.cleanup.thread).toBe('not-needed')
    expect(world.counts.deletedThreads).toBeLessThan(world.counts.createdThreads)
  })

  it('makes cleanup failure invalidate an otherwise passing lane', async () => {
    const world = makeFakeWorld(target)
    let first = true
    const transport = {
      ...world.transport,
      deleteThread: async (threadId: Snowflake) => {
        if (first === true) {
          first = false
          throw new Error('fixture cleanup failure')
        }
        await world.transport.deleteThread(threadId)
      },
    }

    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      allowHumanAssisted: true,
    })
    const eligible = receipt.scenarios.find((scenario) => scenario.scenario === 'automatic-eligible')

    expect(receipt.verdict).toBe('FAIL')
    expect(eligible?.verdict).toBe('FAIL')
    expect(eligible?.reason).toBe('cleanup-failed')
    expect(eligible?.assertions).toBe('passed')
    expect(eligible?.cleanup.failures).toEqual([{ artifact: 'thread', cause: { kind: 'unknown' } }])
    expect(eligible?.cleanup.thread).toBe('failed')
    expect(receipt.scenarios).toHaveLength(11)
    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'UNRUN')).toHaveLength(10)
    expect(world.counts.createdMessages).toBe(1)
  })

  it('keeps failed assertions despite a simultaneous cleanup failure and sanitizes REST and broker causes', async () => {
    const world = makeFakeWorld(target)
    const transport = {
      ...world.transport,
      findThreadForMessage: async () => undefined,
      deleteMessage: async () => {
        throw new BrokerOperationFailure('capture-click-failed', 1, undefined, undefined, 4)
      },
    }
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      selection: { _tag: 'Scenarios', scenarios: ['automatic-eligible'] },
      allowHumanAssisted: true,
    })
    const scenario = receipt.scenarios.find((item) => item.scenario === 'automatic-eligible')
    expect(scenario).toMatchObject({
      verdict: 'FAIL',
      assertions: 'failed',
      reason: 'assertion-failed',
      cleanup: {
        sourceMessage: 'failed',
        failures: [
          {
            artifact: 'sourceMessage',
            cause: { kind: 'broker', reason: 'capture-click-failed', exitCode: 1, step: 4 },
          },
        ],
      },
    })

    const restReceipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport: {
        ...world.transport,
        deleteMessage: async () => {
          throw new DiscordRestFailure('DELETE', '/api/*', 403, 'DiscordRestError', 50013)
        },
      },
      selection: { _tag: 'Scenarios', scenarios: ['automated-author-rejected'] },
    })
    expect(restReceipt.scenarios.find((item) => item.scenario === 'automated-author-rejected')).toMatchObject({
      assertions: 'passed',
      reason: 'cleanup-failed',
      cleanup: { failures: [{ artifact: 'sourceMessage', cause: { kind: 'rest', status: 403, discordCode: 50013 } }] },
    })
  })

  it('records the allowlisted broker reason when source creation fails', async () => {
    const world = makeFakeWorld(target)
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport: {
        ...world.transport,
        createMessage: async () => {
          throw new BrokerOperationFailure('capture-navigate-failed', 1, undefined, undefined, 1)
        },
      },
      selection: { _tag: 'Scenarios', scenarios: ['automatic-eligible'] },
      allowHumanAssisted: true,
    })
    expect(receipt.scenarios.find((item) => item.scenario === 'automatic-eligible')?.failure).toEqual({
      step: 'createOwnedMessage',
      errorClass: 'BrokerOperationFailure',
      message: 'broker-failed',
      cause: { kind: 'broker', reason: 'capture-navigate-failed', exitCode: 1, step: 1 },
    })
  })

  it('records the failing operator step and allowlisted admin diagnostics without response content', async () => {
    const world = makeFakeWorld(target)
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      selection: { _tag: 'Scenarios', scenarios: ['operator-retroactive'] },
      transport: {
        ...world.transport,
        operatorCreateThread: async () => {
          throw new AdminControlFailure(
            'admin-http-error',
            409,
            'ControlApplicationFailure',
            'Thread creation failed: discord_definitive_failure',
          )
        },
      },
    })
    const scenario = receipt.scenarios.find((item) => item.scenario === 'operator-retroactive')
    expect(scenario).toMatchObject({
      verdict: 'FAIL',
      reason: 'transport-failed',
      assertions: 'not-reached',
      failure: {
        step: 'operatorCreateThread',
        errorClass: 'AdminControlFailure',
        message: 'admin-http-error',
        httpStatus: 409,
        controlResultTag: 'ControlApplicationFailure',
        serverMessage: 'Thread creation failed: discord_definitive_failure',
      },
      cleanup: { sourceMessage: 'deleted' },
    })
    expect(world.counts.createdMessages).toBe(1)
    expect(world.counts.deletedMessages).toBe(1)
    const injected = await runE2EMatrix({
      environment: 'fake',
      target,
      selection: { _tag: 'Scenarios', scenarios: ['operator-retroactive'] },
      transport: {
        ...makeFakeWorld(target).transport,
        operatorCreateThread: async () => {
          throw new AdminControlFailure('admin-http-error', 409, 'ControlApplicationFailure', 'Bearer secret-token')
        },
      },
    })
    expect(injected.scenarios.find((item) => item.scenario === 'operator-retroactive')?.failure?.serverMessage).toBe(
      'other',
    )
    expect(JSON.stringify(injected)).not.toContain('secret-token')
    const unsafe = await runE2EMatrix({
      environment: 'fake',
      target,
      selection: { _tag: 'Scenarios', scenarios: ['operator-retroactive'] },
      transport: {
        ...makeFakeWorld(target).transport,
        operatorCreateThread: async () => {
          throw new Error('Authorization: Bearer secret-token; message body private')
        },
      },
    })
    expect(unsafe.scenarios.find((item) => item.scenario === 'operator-retroactive')?.failure).toEqual({
      step: 'operatorCreateThread',
      errorClass: 'Error',
      message: 'unexpected-error',
    })
    expect(JSON.stringify(unsafe)).not.toContain('secret-token')
  })

  it('does not cleanup-own an uncorrelated response returned by a remote lane', async () => {
    const world = makeFakeWorld(target)
    const transport = {
      ...world.transport,
      invokeDocs: async (input: Parameters<typeof world.transport.invokeDocs>[0]) => {
        const result = await world.transport.invokeDocs(input)
        const responses: [ResponseSnapshot, ...ResponseSnapshot[]] = [
          { ...result.responses[0], marker: 'unrelated' },
          ...result.responses.slice(1).map((response) => ({ ...response, marker: 'unrelated' })),
        ]
        return {
          ...result,
          responses,
        }
      },
    }

    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      allowHumanAssisted: true,
    })
    const docs = receipt.scenarios.find((scenario) => scenario.scenario === 'docs-public')

    expect(docs?.verdict).toBe('FAIL')
    expect(docs?.cleanup.response).toBe('not-needed')
    expect(world.responses.size).toBeGreaterThan(0)
  })

  it('preflights and owns docs responses in their explicitly declared channels', async () => {
    const world = makeFakeWorld(target)
    const inspected: Snowflake[] = []
    const invoked: Array<{ readonly channelId: Snowflake; readonly location: 'public' | 'restricted' }> = []
    const transport = {
      ...world.transport,
      inspectChannel: async (channelId: Snowflake) => {
        inspected.push(channelId)
        return world.transport.inspectChannel(channelId)
      },
      invokeDocs: async (input: Parameters<typeof world.transport.invokeDocs>[0]) => {
        invoked.push({ channelId: input.channelId, location: input.location })
        return world.transport.invokeDocs(input)
      },
    }

    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      transport,
      allowHumanAssisted: true,
    })

    expect(receipt.verdict).toBe('PASS')
    expect(new Set(inspected)).toEqual(new Set([channelId, restrictedDocsChannelId]))
    expect(invoked).toEqual([
      { channelId, location: 'public' },
      { channelId: restrictedDocsChannelId, location: 'restricted' },
      { channelId: restrictedDocsChannelId, location: 'restricted' },
    ])
  })
})
