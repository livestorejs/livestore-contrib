import { describe, expect, it, vi } from 'vitest'

import { topicSentinel, type RunReceipt, type Verdict } from './model.ts'
import { actorTokenEnvironmentVariable, runStagingCli, stagingCliExit } from './staging-cli.ts'

const manifest = JSON.stringify({
  schemaVersion: 1,
  environment: 'staging',
  actorBotTokenRef: 'op://LiveStore/Discord staging actor/token',
  botControlSocket: '/run/discord-bot/staging/control.sock',
  target: {
    guildId: '111111111111111111',
    channelId: '222222222222222222',
    docsChannelIds: { public: '222222222222222222', restricted: '333333333333333333' },
    allowedChannelIds: ['222222222222222222', '333333333333333333'],
    requiredTopicSentinel: topicSentinel,
    pollIntervalMs: 1_000,
    timeoutMs: 30_000,
  },
})

const args = [
  '--live',
  '--manifest',
  'staging.json',
  '--confirm-live-write',
  'I_UNDERSTAND_THIS_WRITES_TO_DISCORD_STAGING',
]

const receipt = (verdict: Verdict): RunReceipt => ({
  schemaVersion: 1,
  runId: '11111111-1111-4111-8111-111111111111' as RunReceipt['runId'],
  environment: 'staging',
  startedAt: '2026-08-23T00:00:00.000Z',
  finishedAt: '2026-08-23T00:00:01.000Z',
  scenarios: [],
  verdict,
})

describe('standalone staging E2E CLI', () => {
  it.each([
    ['PASS', stagingCliExit.pass],
    ['FAIL', stagingCliExit.fail],
    ['UNRUN', stagingCliExit.unrun],
  ] as const)('maps %s receipt to its truthful exit code', async (verdict, exitCode) => {
    const run = vi.fn(async () => receipt(verdict))
    const result = await runStagingCli({
      args,
      environment: { [actorTokenEnvironmentVariable]: 'injected-secret' },
      dependencies: { readTextFile: async () => manifest, run },
    })

    expect(result.exitCode).toBe(exitCode)
    expect(result.stderr).toEqual([])
    expect(JSON.parse(result.stdout[0]!)).toEqual(receipt(verdict))
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ actorBotToken: 'injected-secret', humanAssisted: false }),
    )
    expect(result.stdout.join('\n')).not.toContain('injected-secret')
    expect(result.stdout.join('\n')).not.toContain('op://')
  })

  it("accepts pnpm's conventional leading option separator", async () => {
    const result = await runStagingCli({
      args: ['--', ...args],
      environment: {},
      dependencies: {
        readTextFile: async () => manifest,
        run: async () => receipt('UNRUN'),
      },
    })

    expect(result.exitCode).toBe(stagingCliExit.unrun)
  })

  it('enables human lanes only with an explicit attended broker executable', async () => {
    const run = vi.fn(async () => receipt('UNRUN'))
    await runStagingCli({
      args: [...args, '--human-handoff-broker', '/opt/e2e/human-broker'],
      environment: {},
      dependencies: { readTextFile: async () => manifest, run },
    })

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        humanAssisted: true,
        humanHandoffBrokerExecutable: '/opt/e2e/human-broker',
      }),
    )
  })

  it.each([
    ['missing --live', args.filter((value) => value !== '--live')],
    ['duplicate --live', ['--live', ...args]],
    ['wrong confirmation', args.map((value) => (value.startsWith('I_UNDERSTAND') === true ? 'yes' : value))],
    ['missing manifest', args.slice(0, 1)],
    ['unknown token option', [...args, '--token', 'secret']],
  ])('rejects %s before reading configuration or running', async (_label, invalidArgs) => {
    const readTextFile = vi.fn(async () => manifest)
    const run = vi.fn(async () => receipt('PASS'))
    const result = await runStagingCli({
      args: invalidArgs,
      environment: {},
      dependencies: { readTextFile, run },
    })

    expect(result.exitCode).toBe(stagingCliExit.usage)
    expect(result.stdout).toEqual([])
    expect(readTextFile).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a malformed manifest before running', async () => {
    const run = vi.fn(async () => receipt('PASS'))
    const result = await runStagingCli({
      args,
      environment: {},
      dependencies: { readTextFile: async () => '{}', run },
    })

    expect(result.exitCode).toBe(stagingCliExit.usage)
    expect(result.stderr[0]).toContain('manifest rejected')
    expect(run).not.toHaveBeenCalled()
  })

  it('passes an absent environment token through as UNRUN-capable input', async () => {
    const run = vi.fn(async (input) => receipt(input.actorBotToken === undefined ? 'UNRUN' : 'FAIL'))
    const result = await runStagingCli({
      args,
      environment: {},
      dependencies: { readTextFile: async () => manifest, run },
    })

    expect(result.exitCode).toBe(stagingCliExit.unrun)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ actorBotToken: undefined }))
  })

  it('turns pre-receipt defects into a content-free FAIL', async () => {
    const result = await runStagingCli({
      args,
      environment: { [actorTokenEnvironmentVariable]: 'never-print-me' },
      dependencies: {
        readTextFile: async () => manifest,
        run: async () => {
          throw new Error('provider leaked never-print-me')
        },
      },
    })

    expect(result.exitCode).toBe(stagingCliExit.fail)
    expect(result.stdout).toEqual([])
    expect(result.stderr.join('\n')).not.toContain('never-print-me')
  })
})
