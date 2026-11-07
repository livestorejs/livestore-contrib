import type { RelayOutbox } from './outbox.ts'

/** One ordered drain step. Only a terminal acknowledgment can remove the durable entry. */
export const forwardRelayMessage = async (input: {
  readonly endpoint: URL
  readonly token: string
  readonly owner: string
  readonly outbox: Pick<RelayOutbox, 'next' | 'acknowledge' | 'retry'>
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
}): Promise<'empty' | 'acknowledged' | 'retry'> => {
  const now = Date.now()
  const entry = input.outbox.next(now)
  if (entry === undefined) return 'empty'

  const { guildId, channelId, messageId } = entry
  if ((await sendRelayJson({ ...input, payload: { guildId, channelId, messageId } })) === false) {
    input.outbox.retry(entry.ordinal, Date.now())
    return 'retry'
  }
  input.outbox.acknowledge(entry)
  return 'acknowledged'
}

export const sendRelayJson = async (input: {
  readonly endpoint: URL
  readonly token: string
  readonly owner: string
  readonly payload: unknown
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
}): Promise<boolean> => {
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

  let response: Response
  try {
    response = await (input.fetcher ?? fetch)(input.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'x-relay-owner': input.owner,
      },
      body: JSON.stringify(input.payload),
      signal: input.signal,
    })
  } catch {
    return false
  }
  if (response.status !== 204) {
    await response.body?.cancel().catch(() => undefined)
    return false
  }

  return true
}
