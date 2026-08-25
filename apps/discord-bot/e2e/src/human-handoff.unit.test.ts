import { describe, expect, it, vi } from 'vitest'

import { makeCommandHumanHandoffBroker } from './human-handoff.ts'
import type { Snowflake } from './model.ts'

describe('attended human handoff broker', () => {
  it('uses an explicit executable and decodes a human-owned message', async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: '333333333333333333',
        channelId: '222222222222222222',
        marker: 'marker',
        attendedByHuman: true,
      }),
      stderr: '',
    }))
    const broker = makeCommandHumanHandoffBroker({ executable: '/opt/e2e/human-broker', runCommand })

    await expect(
      broker.createMessage({
        channelId: '222222222222222222' as Snowflake,
        marker: 'marker',
        content: 'question',
      }),
    ).resolves.toEqual(expect.objectContaining({ author: 'human' }))
    const [executable, argv] = runCommand.mock.calls[0] as unknown as [string, Array<string>]
    expect(executable).toBe('/opt/e2e/human-broker')
    expect(argv.slice(0, 3)).toEqual(['create-message', '--request-json', expect.any(String)])
    // Every invocation carries the run-scoped ledger identity.
    expect(argv.slice(3)).toEqual(['--run-id', expect.any(String), '--ledger', expect.stringMatching(/ledger-.*\.jsonl$/)])
  })

  it('maps an unavailable human to a prerequisite instead of PASS', async () => {
    const broker = makeCommandHumanHandoffBroker({
      executable: '/opt/e2e/human-broker',
      runCommand: async () => ({ exitCode: 7, stdout: '', stderr: 'no human' }),
    })
    await expect(
      broker.createMessage({
        channelId: '222222222222222222' as Snowflake,
        marker: 'marker',
        content: 'question',
      }),
    ).rejects.toMatchObject({ name: 'E2EPrerequisiteUnavailableError' })
  })

  it('rejects an un-attested executable result as unavailable', async () => {
    const broker = makeCommandHumanHandoffBroker({
      executable: '/opt/e2e/not-attended',
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          id: '333333333333333333',
          channelId: '222222222222222222',
          marker: 'marker',
        }),
        stderr: '',
      }),
    })
    await expect(
      broker.createMessage({
        channelId: '222222222222222222' as Snowflake,
        marker: 'marker',
        content: 'question',
      }),
    ).rejects.toMatchObject({ name: 'E2EPrerequisiteUnavailableError' })
  })

  it('requires attended, ID-correlated cleanup confirmation', async () => {
    const broker = makeCommandHumanHandoffBroker({
      executable: '/opt/e2e/human-broker',
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          attendedByHuman: true,
          deleted: true,
          id: '999999999999999999',
        }),
        stderr: '',
      }),
    })
    await expect(
      broker.deleteMessage({
        id: '333333333333333333' as Snowflake,
        channelId: '222222222222222222' as Snowflake,
        marker: 'marker',
        author: 'human',
      }),
    ).rejects.toThrow('correlated cleanup')
  })

  it('preserves every correlated docs response artifact for cleanup', async () => {
    let requestArguments: ReadonlyArray<string> = []
    const runCommand = async (_executable: string, args: ReadonlyArray<string>) => {
      requestArguments = args
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          _tag: 'Answered',
          attendedByHuman: true,
          responses: [
            {
              id: '333333333333333333',
              channelId: '222222222222222222',
              marker: 'marker',
              hasAnswer: true,
              hasSources: true,
            },
            {
              id: '444444444444444444',
              channelId: '222222222222222222',
              marker: 'marker',
              hasAnswer: true,
              hasSources: false,
            },
          ],
        }),
        stderr: '',
      }
    }
    const broker = makeCommandHumanHandoffBroker({ executable: '/opt/e2e/human-broker', runCommand })

    const result = await broker.invokeDocs({
      channelId: '222222222222222222' as Snowflake,
      marker: 'marker',
      query: 'question',
      location: 'public',
      persona: 'member',
    })

    expect(result.responses.map((response) => response.id)).toEqual(['333333333333333333', '444444444444444444'])
    expect(requestArguments[0]).toBe('invoke-docs')
    expect(requestArguments[2]).toContain('"channelId":"222222222222222222"')
  })
})
