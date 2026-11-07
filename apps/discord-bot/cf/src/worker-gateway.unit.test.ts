import { Effect } from 'effect'
import { expect, it, vi } from 'vitest'

import { runWorkerGateway } from './worker-gateway.ts'

const guildId = '100000000000000001'
const channelId = '100000000000000002'
const first = '100000000000000003'
const second = '100000000000000004'

it('captures a reference before DFX checkpoints it and closes resumably if intake fails', async () => {
  const observed: string[] = []
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
        this.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 'test', resume_gateway_url: this.url } })
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
        this.emit({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 4,
          d: { type: 0, guild_id: guildId, channel_id: channelId, id: second },
        })
      })
    }

    send() {}
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
        session: undefined,
        until: Date.now() + 5_000,
        expiresAt: Date.now() + 5_000,
        owner: {
          isOwner: () => Effect.succeed(true),
          renew: () => Effect.succeed(Date.now() + 5_000),
          allowIdentify: () => Effect.succeed(true),
          checkpoint: (session) =>
            Effect.sync(() => {
              observed.push(`checkpoint:${session?.sequence}`)
              return true
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
    expect(observed).toEqual(['checkpoint:1', 'checkpoint:2', `capture:${first}`, 'checkpoint:3', `capture:${second}`])
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
