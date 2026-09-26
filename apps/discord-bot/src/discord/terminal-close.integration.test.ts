import { DiscordWS } from 'dfx/gateway'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import * as Socket from 'effect/unstable/socket/Socket'
import { describe, expect, it } from 'vitest'

import { terminalGatewayCloseCodes } from './terminal-close.ts'

type WebSocketBinaryType = 'blob' | 'arraybuffer'

describe('selected DFX terminal-close behavior', () => {
  it.each(terminalGatewayCloseCodes)('stops after terminal code %i and exposes the typed failure', async (code) => {
    const observation = await observeTerminalClose(code)
    expect(observation.attempts).toBe(1)
    expect(observation.failure).toMatchObject({
      _tag: 'TerminalGatewayCloseError',
      code,
    })
  })

  it('continues reconnecting after transient code 4000', async () => {
    expect(await observeConnectionAttempts(4000)).toBeGreaterThan(1)
  })
})

const observeTerminalClose = (code: number) => {
  let attempts = 0
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (_url: string) => {
    attempts += 1
    const socket = new ClosingWebSocket(code)
    queueMicrotask(() => socket.emitClose())
    return socket
  })

  return Effect.runPromise(
    Effect.gen(function* () {
      const discordWs = yield* DiscordWS.DiscordWS
      const socket = yield* discordWs.connect({ onConnecting: Effect.void })
      const failureFiber = yield* socket.failure.pipe(Effect.flip, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* TestClock.adjust('2 seconds')
      yield* Effect.yieldNow
      return { attempts, failure: yield* Fiber.join(failureFiber) }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          DiscordWS.DiscordWSLive.pipe(Layer.provide(DiscordWS.JsonDiscordWSCodecLive)),
          constructorLayer,
          TestClock.layer(),
        ),
      ),
    ),
  )
}

const observeConnectionAttempts = (code: number) => {
  let attempts = 0
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (_url: string) => {
    attempts += 1
    const socket = new ClosingWebSocket(code)
    queueMicrotask(() => socket.emitClose())
    return socket
  })

  return Effect.runPromise(
    Effect.gen(function* () {
      const discordWs = yield* DiscordWS.DiscordWS
      yield* discordWs.connect({ onConnecting: Effect.void })
      yield* Effect.yieldNow
      yield* TestClock.adjust('2 seconds')
      yield* Effect.yieldNow
      return attempts
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          DiscordWS.DiscordWSLive.pipe(Layer.provide(DiscordWS.JsonDiscordWSCodecLive)),
          constructorLayer,
          TestClock.layer(),
        ),
      ),
    ),
  )
}

class ClosingWebSocket extends EventTarget implements globalThis.WebSocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readonly bufferedAmount = 0
  readonly extensions = ''
  readonly protocol = ''
  readonly readyState = this.OPEN
  readonly url = 'wss://gateway.discord.gg/'
  binaryType: WebSocketBinaryType = 'blob'
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null

  constructor(private readonly code: number) {
    super()
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView) {}
  close(_code?: number, _reason?: string) {}

  emitClose() {
    const event = new Event('close')
    Object.defineProperties(event, {
      code: { value: this.code },
      reason: { value: 'terminal-close differential probe' },
    })
    this.dispatchEvent(event)
  }
}
