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
