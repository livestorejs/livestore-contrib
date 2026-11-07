import { Schema } from 'effect'
import { expect, it } from 'vitest'

import { DiscordMessageRef } from '../threading/model.ts'
import { forwardRelayMessage } from './forward.ts'
import { openRelayOutbox } from './outbox.ts'

it('retries an ambiguous delivery and acknowledges only the terminal response', async () => {
  const source = Schema.decodeSync(DiscordMessageRef)({
    guildId: '100000000000000001',
    channelId: '100000000000000002',
    messageId: '100000000000000003',
  })
  const outbox = openRelayOutbox(':memory:', 2)
  try {
    outbox.enqueue(source)
    const later = Schema.decodeSync(DiscordMessageRef)({ ...source, messageId: '100000000000000004' })
    outbox.enqueue(later)
    const statuses = [503, 204]
    const input = {
      endpoint: new URL('https://relay.test/gateway/messages'),
      token: 'test-credential',
      owner: 'test-owner',
      outbox,
      signal: AbortSignal.timeout(1_000),
      fetcher: (async (_url, options) => {
        expect(options?.body).toBe(JSON.stringify(statuses.length === 2 ? source : later))
        expect(options?.redirect).toBe('error')
        return new Response(null, { status: statuses.shift() ?? 500 })
      }) as typeof fetch,
    }
    expect(await forwardRelayMessage(input)).toBe('retry')
    expect(outbox.next()).toMatchObject(later)
    expect(await forwardRelayMessage(input)).toBe('acknowledged')
    expect(await forwardRelayMessage(input)).toBe('empty')
    expect(outbox.next(Date.now() + 30_000)).toMatchObject(source)
  } finally {
    outbox.close()
  }
})
