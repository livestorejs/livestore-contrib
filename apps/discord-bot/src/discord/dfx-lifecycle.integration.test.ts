import { DiscordConfig, MemoryRateLimitStoreLive } from "dfx"
import { DiscordGateway, DiscordGatewayLive, DiscordWS, ShardStore } from "dfx/gateway"
import { ShardStateStore } from "dfx/DiscordGateway/Shard/StateStore"
import { Effect, Layer, Option, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { describe, expect, it } from "vitest"

/**
 * This deliberately exercises DFX's Sharder and Shard layers, rather than
 * reproducing their PubSub/queue implementation in application code.
 */
describe("DFX gateway lifecycle wiring", () => {
  it("replays READY emitted before a late gateway subscriber", async () => {
    const gateway = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* DiscordGateway
          yield* Effect.sleep("50 millis")
          return Option.getOrThrow(yield* Stream.runHead(Stream.filter(service.lifecycle, event => event._tag === "Ready")))
        }),
      ).pipe(Effect.provide(makeGatewayLayer((_url: string) => new TestGatewaySocket()))),
    )

    expect(gateway).toEqual({ _tag: "Ready", shardId: 0 })
  })

  it("propagates a terminal close through Sharder to DiscordGateway.failure", async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* DiscordGateway
          return yield* service.failure.pipe(Effect.flip)
        }),
      ).pipe(Effect.provide(makeGatewayLayer((_url: string) => new TerminalGatewaySocket()))),
    )

    expect(failure).toMatchObject({ _tag: "TerminalGatewayCloseError", code: 4004 })
  })
})

const testHttpClient = HttpClient.make(request =>
  Effect.succeed(
      HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          url: "wss://gateway.discord.test",
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 1000,
            reset_after: 0,
            max_concurrency: 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  ),
)

class TestGatewaySocket extends EventTarget implements globalThis.WebSocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readonly bufferedAmount = 0
  readonly extensions = ""
  readonly protocol = ""
  readonly readyState = this.OPEN
  readonly url = "wss://gateway.discord.test"
  binaryType: BinaryType = "blob"
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null

  constructor() {
    super()
    queueMicrotask(() => this.emitMessage({ op: 10, d: { heartbeat_interval: 60_000 } }))
    queueMicrotask(() =>
      this.emitMessage({
        op: 0,
        t: "READY",
        s: 1,
        d: { session_id: "test-session", resume_gateway_url: "wss://gateway.discord.test" },
      }),
    )
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView) {}
  close(_code?: number, _reason?: string) {}

  private emitMessage(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }
}

class TerminalGatewaySocket extends EventTarget implements globalThis.WebSocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readonly bufferedAmount = 0
  readonly extensions = ""
  readonly protocol = ""
  readonly readyState = this.OPEN
  readonly url = "wss://gateway.discord.test"
  binaryType: BinaryType = "blob"
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null

  constructor() {
    super()
    queueMicrotask(() => {
      const event = new Event("close")
      Object.defineProperties(event, {
        code: { value: 4004 },
        reason: { value: "terminal-close wiring probe" },
      })
      this.dispatchEvent(event)
    })
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView) {}
  close(_code?: number, _reason?: string) {}
}

const makeGatewayLayer = (socketConstructor: (url: string) => WebSocket) => DiscordGatewayLive.pipe(
  Layer.provide(
    DiscordConfig.layer({
      token: Redacted.make("test-token"),
      rest: { baseUrl: "https://discord.test" },
      gateway: { shardCount: 1, identifyRateLimit: [1_000, 1] },
    }),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(Socket.WebSocketConstructor, socketConstructor),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      MemoryRateLimitStoreLive,
      ShardStore.MemoryShardStoreLive,
      ShardStateStore.MemoryLive,
      DiscordWS.JsonDiscordWSCodecLive,
    ),
  ),
)
