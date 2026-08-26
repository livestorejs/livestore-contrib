import { describe, expect, it } from 'vitest'

import { parseControlSocketOption } from './socket-option.ts'

describe('control socket CLI option', () => {
  it('admits one explicit normalized socket without changing command arguments', () => {
    expect(
      parseControlSocketOption([
        'thread',
        'create',
        'https://discord.com/channels/10000000000000001/10000000000000002/10000000000000003',
        '--socket',
        '/run/discord-bot/staging/control.sock',
      ]),
    ).toEqual({ _tag: 'Parsed', path: '/run/discord-bot/staging/control.sock' })
  })

  it.each([
    ['missing value', ['thread', 'inspect', '--socket']],
    ['relative path', ['thread', 'inspect', '--socket', 'control.sock']],
    ['non-socket path', ['thread', 'inspect', '--socket', '/run/discord-bot/staging/control']],
    ['duplicate option', ['thread', 'inspect', '--socket', '/run/one.sock', '--socket', '/run/two.sock']],
  ])('rejects %s', (_label, args) => {
    expect(parseControlSocketOption(args)._tag).toBe('UsageError')
  })
})
