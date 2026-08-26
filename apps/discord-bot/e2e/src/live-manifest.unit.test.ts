import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseLiveManifest } from './live-manifest.ts'
import { topicSentinel } from './model.ts'

const valid = {
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
}

describe('live staging manifest', () => {
  it('accepts a staging-only, allowlisted manifest with credential indirection', () => {
    const manifest = parseLiveManifest(valid)
    expect(manifest.environment).toBe('staging')
    expect(manifest.target.allowedChannelIds.has(manifest.target.channelId)).toBe(true)
    expect(manifest.target.allowedChannelIds.has(manifest.target.docsChannelIds.restricted)).toBe(true)
  })

  it('accepts an HTTPS admin endpoint manifest without a control socket', () => {
    const manifest = parseLiveManifest({
      ...valid,
      botControlSocket: undefined,
      botAdminEndpoint: 'https://discordbot-discordbot-staging.example.workers.dev',
    })
    expect(manifest.botAdminEndpoint).toBe('https://discordbot-discordbot-staging.example.workers.dev')
    expect(manifest.botControlSocket).toBeUndefined()
  })

  it.each([
    ['insecure admin endpoint', { ...valid, botAdminEndpoint: 'http://discordbot-staging.workers.dev' }],
    ['admin endpoint with query', { ...valid, botAdminEndpoint: 'https://host.workers.dev/?x=1' }],
    ['admin endpoint with credentials', { ...valid, botAdminEndpoint: 'https://u:p@host.workers.dev' }],
    ['non-URL admin endpoint', { ...valid, botAdminEndpoint: 'not-a-url' }],
    [
      'endpoint combined with socket',
      {
        ...valid,
        botAdminEndpoint: 'https://discordbot-discordbot-staging.example.workers.dev',
        botControlSocket: '/run/discord-bot/staging/control.sock',
      },
    ],
  ])('rejects %s', (_label, manifest) => {
    expect(() => parseLiveManifest(manifest)).toThrow()
  })

  it('validates both shipped example fixtures', () => {
    for (const name of ['staging.example.json', 'staging-cf.example.json']) {
      const raw = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
      const manifest = parseLiveManifest(JSON.parse(raw))
      expect(manifest.environment).toBe('staging')
      if (name === 'staging-cf.example.json') {
        expect(manifest.botAdminEndpoint).toMatch(/^https:\//u)
        expect(manifest.botControlSocket).toBeUndefined()
      }
    }
  })
  it.each([
    ['production target', { ...valid, environment: 'production' }],
    ['inline credential', { ...valid, actorBotTokenRef: 'raw-token' }],
    ['non-allowlisted channel', { ...valid, target: { ...valid.target, allowedChannelIds: [] } }],
    [
      'non-allowlisted restricted docs channel',
      { ...valid, target: { ...valid.target, allowedChannelIds: ['222222222222222222'] } },
    ],
    [
      'ambiguous docs channels',
      {
        ...valid,
        target: {
          ...valid.target,
          docsChannelIds: { public: '222222222222222222', restricted: '222222222222222222' },
        },
      },
    ],
    ['wrong topic sentinel', { ...valid, target: { ...valid.target, requiredTopicSentinel: 'general' } }],
    ['production socket', { ...valid, botControlSocket: '/run/discord-bot/prod/control.sock' }],
    ['socket traversal', { ...valid, botControlSocket: '/run/discord-bot/staging/../production/control.sock' }],
    ['non-socket endpoint', { ...valid, botControlSocket: '/run/discord-bot/staging/control' }],
    ['unknown root field', { ...valid, inlineToken: 'secret' }],
    ['unknown target field', { ...valid, target: { ...valid.target, channelName: 'e2e' } }],
  ])('rejects %s', (_label, manifest) => {
    expect(() => parseLiveManifest(manifest)).toThrow()
  })
})
