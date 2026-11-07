import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { checkDeployPlan } from './check-deploy-plan.ts'

const allowed = `Plan: 1 to update
[DiscordBot] update
[DiscordBot/RELEASE_ID] create
[DiscordBot/ADMIN_TOKEN] update
`

describe('Discord bot deploy plan gate', () => {
  it('allows an existing Worker update with binding creates and updates', () => {
    expect(checkDeployPlan(allowed)).toBe(true)
  })

  it.each([
    ['new Worker', 'Plan: 1 to create\n[DiscordBot] create\n'],
    ['new Durable Object', 'Plan: 1 to update, 1 to create\n[DiscordBot] update\n[BotState] create\n'],
    ['replacement', 'Plan: 1 to replace\n[DiscordBot] replace\n'],
    ['deletion', 'Plan: 1 to update, 1 to delete\n[DiscordBot] update\n[Other] delete\n'],
    ['binding deletion', 'Plan: 1 to update\n[DiscordBot] update\n[DiscordBot/ADMIN_TOKEN] delete\n'],
    ['extra resource', 'Plan: 2 to update\n[DiscordBot] update\n[Other] update\n'],
    ['unrecognized plan', 'Plan: no changes\n'],
    ['missing Worker', 'Plan: 1 to update\n[BotState] update\n'],
    ['truncated plan', 'Plan: 2 to update\n[DiscordBot] update\n'],
    ['ambiguous output', `${allowed}${allowed}`],
  ])('rejects %s', (_reason, plan) => {
    expect(() => checkDeployPlan(plan)).toThrow()
  })
})

/** Bootstrap plan shape with the production Worker's declared bindings. */
const firstProductionPlan = `Plan: 1 to create
[DiscordBot] create
[DiscordBot/ADMIN_TOKEN] create
[DiscordBot/BotState] create
[DiscordBot/CF_VERSION_METADATA] create
[DiscordBot/Cron(* * * * *)] create
[DiscordBot/DEPLOY_STAGE] create
[DiscordBot/DISCORD_APPLICATION_ID] create
[DiscordBot/DISCORD_BOT_TOKEN] create
[DiscordBot/DOCS_CORRELATION_KEY] create
[DiscordBot/OPENAI_API_KEY] create
[DiscordBot/RELEASE_ID] create
`

it('admits precisely the first production Worker with its declared bindings only in bootstrap mode', () => {
  expect(checkDeployPlan(firstProductionPlan, 'production', true)).toBe(true)
  expect(() => checkDeployPlan(firstProductionPlan)).toThrow()
  expect(() => checkDeployPlan(firstProductionPlan, 'staging', true)).toThrow()
  expect(() => checkDeployPlan(allowed, 'production', true)).toThrow()
  expect(() =>
    checkDeployPlan(firstProductionPlan.replace('[DiscordBot/BotState] create\n', ''), 'production', true),
  ).toThrow()
  expect(() =>
    checkDeployPlan(firstProductionPlan.replace('[DiscordBot/OPENAI_API_KEY] create\n', ''), 'production', true),
  ).toThrow()
  expect(() =>
    checkDeployPlan(firstProductionPlan + '[DiscordBot/E2E_ACTOR_TOKEN] create\n', 'production', true),
  ).toThrow()
  expect(() =>
    checkDeployPlan(firstProductionPlan.replace('1 to create', '2 to create') + '[Other] create\n', 'production', true),
  ).toThrow()
  expect(() =>
    checkDeployPlan(
      firstProductionPlan.replace('[DiscordBot/DISCORD_BOT_TOKEN] create', '[DiscordBot/DISCORD_BOT_TOKEN] update'),
      'production',
      true,
    ),
  ).toThrow()
})

it('accepts a cron trigger binding row on a Worker update', () => {
  expect(checkDeployPlan(allowed + '[DiscordBot/Cron(* * * * *)] noop\n')).toBe(true)
})

it('allows removing only the Gateway transport binding during explicit rollback', () => {
  const rollback = allowed + '[DiscordBot/GATEWAY_TRANSPORT] delete\n'
  expect(checkDeployPlan(rollback, 'staging', false, true)).toBe(true)
  expect(() => checkDeployPlan(rollback)).toThrow()
  expect(() => checkDeployPlan(rollback + '[DiscordBot/BotState] delete\n', 'staging', false, true)).toThrow()
})

it('requires the explicit embedded rollback override at the deploy plan CLI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-bot-plan-'))
  try {
    const plan = join(directory, 'plan.log')
    writeFileSync(plan, allowed + '[DiscordBot/GATEWAY_TRANSPORT] delete\n')
    const cli = fileURLToPath(new URL('./check-deploy-plan.ts', import.meta.url))
    const check = (transport: string, rollback: string) =>
      spawnSync(process.execPath, ['--experimental-strip-types', cli, plan, '--stage', 'production'], {
        env: { ...process.env, CF_GATEWAY_TRANSPORT: transport, CF_ALLOW_WORKER_GATEWAY_ROLLBACK: rollback },
        encoding: 'utf8',
      })

    const approved = check('embedded', '1')
    expect(approved.status).toBe(0)
    expect(approved.stdout).toContain('Discord bot plan gate passed')
    for (const [transport, rollback] of [
      ['embedded', '0'],
      ['worker', '1'],
    ] as const) {
      const rejected = check(transport, rollback)
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain('binding DiscordBot/GATEWAY_TRANSPORT cannot delete')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
