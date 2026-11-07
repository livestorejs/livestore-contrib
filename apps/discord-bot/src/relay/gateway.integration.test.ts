import { Effect, Stream } from 'effect'
import { WebSocketConstructor } from 'effect/unstable/socket/Socket'
import { expect, it } from 'vitest'

import { openRelayGateway } from './gateway.ts'
import { openRelayOutbox } from './outbox.ts'

const guildId = '100000000000000001'
const channelId = '100000000000000002'
const first = '100000000000000003'
const second = '100000000000000004'

it('queues a message before DFX checkpoints it and stops at a storage failure', async () => {
  const outbox = openRelayOutbox(':memory:', 1)
  try {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* openRelayGateway({
          botToken: 'test-token',
          guildId,
          channels: new Set([channelId]),
          outbox,
        })
        yield* Stream.runHead(Stream.filter(gateway.lifecycle, (event) => event._tag === 'Ready'))
        const exit = yield* Effect.exit(gateway.failure)
        return { exit, session: outbox.session('0-1'), queued: outbox.next() }
      }).pipe(
        Effect.scoped,
        Effect.provideService(WebSocketConstructor, () => new RelayTestSocket()),
        Effect.timeout('5 seconds'),
      ),
    )
    expect(observed.exit._tag).toBe('Failure')
    expect(observed.session?.sequence).toBe(2)
    expect(observed.queued).toMatchObject({ guildId, channelId, messageId: first })
  } finally {
    outbox.close()
  }
})

class RelayTestSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readonly bufferedAmount = 0
  readonly extensions = ''
  readonly protocol = ''
  readonly readyState = this.OPEN
  readonly url = 'wss://gateway.discord.test'
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  onclose = null
  onerror = null
  onmessage = null
  onopen = null

  constructor() {
    super()
    queueMicrotask(() => {
      this.emit({ op: 10, d: { heartbeat_interval: 60_000 } })
      this.emit({
        op: 0,
        t: 'READY',
        s: 1,
        d: { session_id: 'relay-test', resume_gateway_url: this.url },
      })
      this.emit({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { guild_id: guildId, channel_id: channelId, id: first } })
      this.emit({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { guild_id: guildId, channel_id: channelId, id: second } })
    })
  }

  send() {}
  close() {}

  private emit(payload: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }
}
