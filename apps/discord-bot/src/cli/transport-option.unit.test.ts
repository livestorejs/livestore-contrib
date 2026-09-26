import { describe, expect, it } from 'vitest'

import { parseControlEndpointOption, selectControlTransport } from './transport-option.ts'

const baseInput = {
  environmentEndpoint: undefined,
  environmentToken: undefined,
  socketEnvironmentPath: undefined,
  defaultSocketPath: '/run/discord-bot/staging/control.sock',
}

describe('control endpoint CLI option', () => {
  it('parses one explicit endpoint and normalizes trailing slashes', () => {
    expect(parseControlEndpointOption(['runtime', 'status', '--endpoint', 'https://admin.example/'])).toEqual({
      _tag: 'Parsed',
      url: 'https://admin.example',
    })
  })

  it.each([
    ['missing value', ['thread', 'inspect', '--endpoint']],
    ['non-http scheme', ['thread', 'inspect', '--endpoint', 'ftp://admin.example']],
    ['unparseable URL', ['thread', 'inspect', '--endpoint', 'not a url']],
    ['duplicate option', ['runtime', 'status', '--endpoint', 'https://a.example', '--endpoint', 'https://b.example']],
  ])('rejects %s', (_label, args) => {
    expect(parseControlEndpointOption(args)._tag).toBe('UsageError')
  })
})

describe('control transport selection', () => {
  it('gives the explicit --socket flag precedence over a configured endpoint (dev4 parity)', () => {
    expect(
      selectControlTransport({
        ...baseInput,
        args: ['runtime', 'status', '--socket', '/run/explicit.sock', '--endpoint', 'https://admin.example'],
        environmentEndpoint: 'https://env.example',
        environmentToken: 'secret',
      }),
    ).toEqual({ _tag: 'UnixSocket', path: '/run/explicit.sock' })
  })

  it('selects the HTTPS endpoint from the --endpoint flag with the env token', () => {
    expect(
      selectControlTransport({
        ...baseInput,
        args: ['runtime', 'status', '--endpoint', 'https://admin.example/'],
        environmentToken: 'secret',
      }),
    ).toEqual({ _tag: 'HttpsEndpoint', url: 'https://admin.example', token: 'secret' })
  })

  it('falls back to LIVESTORE_DISCORD_ADMIN_ENDPOINT when no flag is present', () => {
    expect(
      selectControlTransport({
        ...baseInput,
        args: ['runtime', 'status'],
        environmentEndpoint: 'https://discordbot-staging.livestore.workers.dev/',
        environmentToken: 'secret',
      }),
    ).toEqual({
      _tag: 'HttpsEndpoint',
      url: 'https://discordbot-staging.livestore.workers.dev',
      token: 'secret',
    })
  })

  it('requires the admin token whenever an endpoint is configured', () => {
    const result = selectControlTransport({
      ...baseInput,
      args: ['runtime', 'status', '--endpoint', 'https://admin.example'],
    })
    expect(result).toMatchObject({ _tag: 'UsageError' })
    if (result._tag === 'UsageError') expect(result.message).toContain('LIVESTORE_DISCORD_ADMIN_TOKEN')
  })

  it('rejects an unparseable endpoint from the environment', () => {
    expect(
      selectControlTransport({
        ...baseInput,
        args: ['runtime', 'status'],
        environmentEndpoint: '::nope',
        environmentToken: 'secret',
      })._tag,
    ).toBe('UsageError')
  })

  it('keeps the Unix-socket fallback when neither socket nor endpoint is configured', () => {
    expect(selectControlTransport({ ...baseInput, args: ['runtime', 'status'] })).toEqual({
      _tag: 'UnixSocket',
      path: '/run/discord-bot/staging/control.sock',
    })
  })

  it('still honors the control-socket environment variable on the fallback lane', () => {
    expect(
      selectControlTransport({
        ...baseInput,
        args: [],
        socketEnvironmentPath: '/run/environment.sock',
      }),
    ).toEqual({ _tag: 'UnixSocket', path: '/run/environment.sock' })
  })

  it('propagates --socket usage errors before considering endpoints', () => {
    expect(
      selectControlTransport({
        ...baseInput,
        args: ['runtime', 'status', '--socket', 'relative.sock'],
        environmentEndpoint: 'https://admin.example',
        environmentToken: 'secret',
      })._tag,
    ).toBe('UsageError')
  })
})
