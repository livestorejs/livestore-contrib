import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { expect, it } from 'vitest'

const migrationScript = resolve(import.meta.dirname, 'state-migrate.ts')

const runSourceProbe = (cwd: string) =>
  spawnSync(
    process.execPath,
    ['--experimental-strip-types', migrationScript, '--source-probe'],
    { cwd, encoding: 'utf8' },
  )

it('reads cf/.alchemy from the cf working directory and rejects an empty app-root state', () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'discord-bot-state-source-'))
  try {
    const cfRoot = join(appRoot, 'cf')
    const stageRoot = join(cfRoot, '.alchemy/state/DiscordBot/staging')
    mkdirSync(stageRoot, { recursive: true })
    writeFileSync(
      join(stageRoot, 'DiscordBot.json'),
      JSON.stringify({
        status: 'created',
        fqn: 'DiscordBot',
        logicalId: 'DiscordBot',
        instanceId: 'fixture-worker',
        resourceType: 'Cloudflare.Worker',
        props: {},
        attr: {},
        bindings: [],
        providerVersion: 0,
        downstream: [],
        removalPolicy: 'destroy',
        providerMode: 'live',
      }),
    )
    writeFileSync(join(stageRoot, '__stack_output__.json'), JSON.stringify({ url: 'fixture' }))

    const wrongRoot = runSourceProbe(appRoot)
    expect(wrongRoot.status).toBe(1)
    expect(JSON.parse(wrongRoot.stdout)).toEqual({
      sourceResourceCount: 0,
      sourceOutputPresent: false,
      sourceComplete: false,
    })

    const correctRoot = runSourceProbe(cfRoot)
    expect(correctRoot.status).toBe(0)
    expect(JSON.parse(correctRoot.stdout)).toEqual({
      sourceResourceCount: 1,
      sourceOutputPresent: true,
      sourceComplete: true,
    })
  } finally {
    rmSync(appRoot, { recursive: true, force: true })
  }
}, 30_000)
