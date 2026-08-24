import { describe, expect, it } from 'vitest'

import { makeFakeWorld } from './fake-transport.ts'
import { runE2EMatrix } from './harness.ts'
import { topicSentinel, type Snowflake, type StagingTarget } from './model.ts'

const guildId = '111111111111111111' as Snowflake
const channelId = '222222222222222222' as Snowflake

const target: StagingTarget = {
  guildId,
  channelId,
  allowedChannelIds: new Set([channelId]),
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
      createdResponses: 5,
      deletedMessages: 8,
      deletedThreads: 5,
      deletedResponses: 5,
    })
    expect(world.messages.size).toBe(0)
    expect(world.threads.size).toBe(0)
    expect(world.responses.size).toBe(0)

    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(guildId)
    expect(serialized).not.toContain(channelId)
    expect(serialized).not.toContain('How does LiveStore')
    expect(serialized).not.toContain('syncing work')
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
    expect(eligible?.cleanup.thread).toBe('failed')
    expect(receipt.scenarios).toHaveLength(11)
    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'UNRUN')).toHaveLength(10)
    expect(world.counts.createdMessages).toBe(1)
  })

  it('does not cleanup-own an uncorrelated response returned by a remote lane', async () => {
    const world = makeFakeWorld(target)
    const transport = {
      ...world.transport,
      invokeDocs: async (input: Parameters<typeof world.transport.invokeDocs>[0]) => {
        const result = await world.transport.invokeDocs(input)
        return { ...result, response: { ...result.response, marker: 'unrelated' } }
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
})
