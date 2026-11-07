import type { RelayOutbox } from './outbox.ts'

/** One ordered drain step. Only a terminal acknowledgment can remove the durable entry. */
export const forwardRelayMessage = async (input: {
  readonly endpoint: URL
  readonly token: string
  readonly outbox: Pick<RelayOutbox, 'next' | 'acknowledge'>
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
}): Promise<'empty' | 'acknowledged' | 'retry'> => {
  if (
    input.endpoint.protocol !== 'https:' ||
    input.endpoint.username !== '' ||
    input.endpoint.password !== '' ||
    input.endpoint.search !== '' ||
    input.endpoint.hash !== '' ||
    input.token === ''
  ) {
    throw new Error('Relay delivery requires an HTTPS endpoint and a separate credential')
  }

  const entry = input.outbox.next()
  if (entry === undefined) return 'empty'

  const { guildId, channelId, messageId } = entry
  let response: Response
  try {
    response = await (input.fetcher ?? fetch)(input.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ guildId, channelId, messageId }),
      signal: input.signal,
    })
  } catch {
    return 'retry'
  }
  if (response.status !== 204) {
    await response.body?.cancel().catch(() => undefined)
    return 'retry'
  }

  input.outbox.acknowledge(entry)
  return 'acknowledged'
}
