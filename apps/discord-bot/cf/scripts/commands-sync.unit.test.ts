import { describe, expect, it, vi } from 'vitest'

import { syncDeployedCommands } from './commands-sync.ts'

const env = {
  ADMIN_TOKEN: 'secret-not-for-logs',
  CF_WORKER_URL: 'https://worker.example.test',
  DISCORD_APPLICATION_ID: '1553674978757451776',
}
const response = (tag: string, summary: string, status = 200) =>
  new Response(JSON.stringify({ _tag: tag, summary }), { status, headers: { 'content-type': 'application/json' } })
const payload = (call: { init: RequestInit } | undefined) => {
  if (typeof call?.init.body !== 'string') throw new Error('Expected a JSON request body')
  return JSON.parse(call.init.body)
}

const run = async (responses: Response[], stage: 'staging' | 'production' = 'staging') => {
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({ url, init })
    return responses[calls.length - 1] ?? response('Invalid', '')
  }) as unknown as typeof fetch
  const log = vi.fn<(message: string) => void>()
  const result = syncDeployedCommands(stage, env, fetcher, log)
  return { result, calls, log }
}

describe('CI post-deploy command reconciliation', () => {
  it('plans, applies, then proves registered commands are drift-free at the stage fingerprint', async () => {
    const { result, calls, log } = await run([
      response('Planned', 'changes=true create=2 update=0 delete=0 unchanged=0'),
      response('Success', 'changes=true create=2 update=0 delete=0 unchanged=0'),
      response('Planned', 'changes=false create=0 update=0 delete=0 unchanged=2'),
    ])
    await result
    expect(calls).toHaveLength(3)
    expect(calls.map(payload)).toEqual(
      [false, true, false].map((apply) => ({
        environment: 'staging',
        reason: 'CI deploy command convergence',
        apply,
        expectedApplicationId: '1541431832195633232',
        expectedGuildId: '1154415661842452532',
      })),
    )
    expect(
      calls.every(
        ({ url, init }) => url.href === 'https://worker.example.test/admin/commands-sync' && init.headers !== undefined,
      ),
    ).toBe(true)
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'Command sync plan: changes=true create=2 update=0 delete=0 unchanged=0',
      'Command sync apply: changes=true create=2 update=0 delete=0 unchanged=0',
      'Command sync verified: changes=false create=0 update=0 delete=0 unchanged=2',
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.ADMIN_TOKEN)
  })

  it('uses the production application and rejects a drifted verification plan', async () => {
    const { result, calls } = await run(
      [
        response('Planned', 'changes=false create=0 update=0 delete=0 unchanged=1'),
        response('AlreadySatisfied', 'changes=false create=0 update=0 delete=0 unchanged=1'),
        response('Planned', 'changes=true create=1 update=0 delete=0 unchanged=0'),
      ],
      'production',
    )
    await expect(result).rejects.toThrow('verification failed')
    expect(payload(calls[0]).expectedApplicationId).toBe(env.DISCORD_APPLICATION_ID)
    expect(payload(calls[0]).environment).toBe('production')
  })

  it('fails closed on an empty registered command set and does not apply after an HTTP failure', async () => {
    const empty = await run([
      response('Planned', 'changes=false create=0 update=0 delete=0 unchanged=0'),
      response('AlreadySatisfied', 'changes=false create=0 update=0 delete=0 unchanged=0'),
      response('Planned', 'changes=false create=0 update=0 delete=0 unchanged=0'),
    ])
    await expect(empty.result).rejects.toThrow('verification failed')
    const rejected = await run([response('InvalidControlInput', 'secret-not-for-logs', 409)])
    await expect(rejected.result).rejects.toThrow('Command sync plan failed (HTTP 409)')
    expect(rejected.calls).toHaveLength(1)
  })
})
