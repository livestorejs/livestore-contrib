import { expect, it } from 'vitest'

import { receiveRelayMessage } from './relay-ingress.ts'

const source = {
  guildId: '100000000000000001',
  channelId: '100000000000000002',
  messageId: '100000000000000003',
}
const request = (body: string, token = 'relay-only') =>
  new Request('https://relay.test/gateway/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  })

it('admits only authenticated, bounded message references and acknowledges settled work', async () => {
  const received: unknown[] = []
  const deliver = async (value: unknown) => {
    received.push(value)
    return received.length === 2
  }
  const receive = (req: Request) => receiveRelayMessage({ request: req, token: 'relay-only', deliver })

  expect((await receive(request(JSON.stringify(source), 'wrong'))).status).toBe(401)
  expect((await receive(request(JSON.stringify({ ...source, content: 'unexpected' })))).status).toBe(400)
  expect((await receive(request('x'.repeat(1025)))).status).toBe(413)
  expect(received).toEqual([])
  expect((await receive(request(JSON.stringify(source)))).status).toBe(503)
  expect((await receive(request(JSON.stringify(source)))).status).toBe(204)
  expect(received).toEqual([source, source])
})
