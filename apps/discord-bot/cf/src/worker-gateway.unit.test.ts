import { Effect } from 'effect'
import { expect, it, vi } from 'vitest'

import { runWorkerGateway } from './worker-gateway.ts'

const guildId = '100000000000000001'
const channelId = '100000000000000002'
const first = '100000000000000003'
const second = '100000000000000004'

it.each([
  { saved: false, failure: 'capture' },
  { saved: true, failure: 'capture' },
  { saved: true, failure: 'checkpoint' },
])('fences DFX dispatch checkpoints (saved cursor: $saved, failed $failure)', async ({ saved, failure }) => {
  const observed: string[] = []
  const handshakes: number[] = []
  const savedSession = { sessionId: 'test', sequence: 1, resumeUrl: 'wss://gateway.discord.test' }
  let closeCode: number | undefined
  class GatewayFixture extends EventTarget {
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
        if (saved === false) {
          this.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 'test', resume_gateway_url: this.url } })
        }
        this.emit({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 2,
          d: {
            type: 12,
            guild_id: guildId,
            channel_id: channelId,
            id: first,
            message_reference: { channel_id: channelId },
          },
        })
        this.emit({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 3,
          d: { type: 0, guild_id: guildId, channel_id: channelId, id: first },
        })
        if (saved === true) this.emit({ op: 0, t: 'RESUMED', s: 4, d: {} })
        this.emit({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: saved === true ? 5 : 4,
          d: { type: 0, guild_id: guildId, channel_id: channelId, id: second },
        })
      })
    }

    send(data: string) {
      const { op } = JSON.parse(data) as { op: number }
      if (op === 2 || op === 6) handshakes.push(op)
    }
    close(code?: number) {
      closeCode = code
    }

    private emit(payload: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
    }
  }

  vi.stubGlobal('WebSocket', GatewayFixture)
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ id: 'application' })))
  try {
    await Effect.runPromise(
      runWorkerGateway({
        token: 'fake',
        applicationId: 'application',
        guildId,
        channels: [channelId],
        session: saved === true ? savedSession : undefined,
        until: Date.now() + 5_000,
        expiresAt: Date.now() + 5_000,
        owner: {
          isOwner: () => Effect.succeed(true),
          renew: () => Effect.succeed(Date.now() + 5_000),
          allowIdentify: () => Effect.succeed(true),
          checkpoint: (session) =>
            Effect.sync(() => {
              observed.push(`checkpoint:${session?.sequence}`)
              return failure !== 'checkpoint' || session?.sequence !== 3
            }),
          capture: ({ messageId }) =>
            Effect.sync(() => {
              observed.push(`capture:${messageId}`)
              return messageId === first
            }),
          drain: () => Effect.void,
        },
      }),
    )
    expect(handshakes).toEqual([saved === true ? 6 : 2])
    expect(observed).toEqual([
      ...(saved === true ? [] : ['checkpoint:1']),
      'checkpoint:2',
      `capture:${first}`,
      'checkpoint:3',
      ...(failure === 'checkpoint'
        ? []
        : saved === true
          ? ['checkpoint:4', `capture:${second}`]
          : [`capture:${second}`]),
    ])
    expect(savedSession.sequence).toBe(1)
    expect(closeCode).toBe(4000)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('fences a RESUME write when the Worker resumes after its lease deadline', async () => {
  const now = Date.now()
  let clock = now
  let ownershipChecks = 0
  const send = vi.fn()
  const close = vi.fn()

  class GatewayFixture extends EventTarget {
    readonly readyState = 1
    readonly send = send
    readonly close = close

    constructor() {
      super()
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) }),
        ),
      )
    }
  }

  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  vi.stubGlobal('WebSocket', GatewayFixture)
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ id: 'application' })))
  try {
    await Effect.runPromise(
      runWorkerGateway({
        token: 'fake',
        applicationId: 'application',
        guildId,
        channels: [channelId],
        session: { sessionId: 'fixture', sequence: 42, resumeUrl: 'wss://gateway.discord.test' },
        until: now + 300,
        expiresAt: now + 100,
        owner: {
          isOwner: () =>
            Effect.sync(() => {
              ownershipChecks += 1
              // The DO confirmed the owner before the local socket resumed.
              if (ownershipChecks === 2) clock = now + 101
              return true
            }),
          renew: () => Effect.succeed(now + 100),
          allowIdentify: () => Effect.succeed(true),
          checkpoint: () => Effect.succeed(true),
          capture: () => Effect.succeed(true),
          drain: () => Effect.void,
        },
      }),
    )
    expect(ownershipChecks).toBeGreaterThanOrEqual(2)
    expect(send).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(4000, undefined)
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
