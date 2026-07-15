type Env = {
  readonly LORO_RELAY_DO: DurableObjectNamespace<LoroRelayDO>
  readonly ALLOWED_ORIGIN?: string
}

type DurableObjectNamespace<T> = {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): T
}

type DurableObjectId = unknown

type DurableObjectState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put<T extends Record<string, unknown>>(values: T): Promise<void>
    put<T>(key: string, value: T): Promise<void>
  }
  acceptWebSocket(socket: CfWebSocket): void
  getWebSockets(): CfWebSocket[]
}

type CfWebSocket = WebSocket & {
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: CfWebSocket }
}

type RelayMessage =
  | { readonly type: 'hello'; readonly clientId: string; readonly snapshotBase64?: string }
  | { readonly type: 'snapshot'; readonly source: string; readonly snapshotBase64: string }
  | { readonly type: 'update'; readonly source: string; readonly updateId: string; readonly updateBase64: string }

const MAX_MESSAGE_BYTES = 512 * 1024
const MAX_ROOM_LENGTH = 80
const RATE_LIMIT_WINDOW_MS = 10_000
const RATE_LIMIT_MESSAGES = 160
const DEFAULT_ALLOWED_ORIGIN = 'http://127.0.0.1:4174'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok')
    if (!url.pathname.startsWith('/loro/')) return new Response('Not found', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket upgrade', { status: 426 })
    }

    const origin = request.headers.get('Origin')
    const allowedOrigin = env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN
    if (origin !== allowedOrigin) return new Response('Forbidden origin', { status: 403 })

    const room = url.pathname.slice('/loro/'.length)
    if (!/^[a-zA-Z0-9_-]+$/.test(room) || room.length > MAX_ROOM_LENGTH) {
      return new Response('Invalid room', { status: 400 })
    }

    const id = env.LORO_RELAY_DO.idFromName(room)
    return env.LORO_RELAY_DO.get(id).fetch(request)
  },
}

export class LoroRelayDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ acceptedAt: Date.now(), windowStartedAt: Date.now(), count: 0 })
    await this.sendSnapshot(server)
    await this.broadcastInfo()
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }

  async webSocketMessage(socket: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.consumeRateLimit(socket)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }))
      socket.close(1013, 'rate limited')
      return
    }
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'message too large')
      return
    }

    const parsed = this.parseMessage(message)
    if (parsed === undefined) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid relay message' }))
      return
    }

    if (parsed.type === 'hello') {
      if (parsed.snapshotBase64 !== undefined) await this.storeSnapshot(parsed.clientId, parsed.snapshotBase64)
      await this.broadcastInfo()
      return
    }

    if (parsed.type === 'snapshot') {
      await this.storeSnapshot(parsed.source, parsed.snapshotBase64)
      await this.broadcastInfo()
      return
    }

    const updatesStored = ((await this.state.storage.get<number>('updatesStored')) ?? 0) + 1
    await this.state.storage.put('updatesStored', updatesStored)
    this.broadcast(socket, parsed)
    await this.broadcastInfo()
  }

  async webSocketClose(): Promise<void> {
    await this.broadcastInfo()
  }

  async webSocketError(): Promise<void> {
    await this.broadcastInfo()
  }

  private async sendSnapshot(socket: CfWebSocket): Promise<void> {
    const snapshotBase64 = await this.state.storage.get<string>('snapshotBase64')
    const source = (await this.state.storage.get<string>('snapshotSource')) ?? 'relay'
    if (snapshotBase64 !== undefined) {
      socket.send(JSON.stringify({ type: 'snapshot', source, snapshotBase64 }))
    }
  }

  private async storeSnapshot(source: string, snapshotBase64: string): Promise<void> {
    if (snapshotBase64.length > MAX_MESSAGE_BYTES) return
    await this.state.storage.put({
      snapshotBase64,
      snapshotSource: source,
      snapshotUpdatedAt: new Date().toISOString(),
    })
  }

  private broadcast(sender: CfWebSocket, payload: RelayMessage): void {
    const raw = JSON.stringify(payload)
    for (const peer of this.state.getWebSockets()) {
      if (peer === sender || peer.readyState !== WebSocket.OPEN) continue
      peer.send(raw)
    }
  }

  private async broadcastInfo(): Promise<void> {
    const info = JSON.stringify({
      type: 'sync-info',
      peers: this.state.getWebSockets().filter((socket: CfWebSocket) => socket.readyState === WebSocket.OPEN).length,
      updatesStored: (await this.state.storage.get<number>('updatesStored')) ?? 0,
      hasSnapshot: (await this.state.storage.get<string>('snapshotBase64')) !== undefined,
    })
    for (const peer of this.state.getWebSockets()) {
      if (peer.readyState === WebSocket.OPEN) peer.send(info)
    }
  }

  private parseMessage(raw: string): RelayMessage | undefined {
    try {
      const parsed = JSON.parse(raw) as Partial<RelayMessage>
      if (parsed.type === 'hello' && typeof parsed.clientId === 'string') return parsed as RelayMessage
      if (
        parsed.type === 'snapshot' &&
        typeof parsed.source === 'string' &&
        typeof parsed.snapshotBase64 === 'string'
      ) {
        return parsed as RelayMessage
      }
      if (
        parsed.type === 'update' &&
        typeof parsed.source === 'string' &&
        typeof parsed.updateId === 'string' &&
        typeof parsed.updateBase64 === 'string'
      ) {
        return parsed as RelayMessage
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private consumeRateLimit(socket: CfWebSocket): boolean {
    const now = Date.now()
    const attachment = socket.deserializeAttachment() as { windowStartedAt: number; count: number } | undefined
    const next =
      attachment === undefined || now - attachment.windowStartedAt > RATE_LIMIT_WINDOW_MS
        ? { windowStartedAt: now, count: 1 }
        : { windowStartedAt: attachment.windowStartedAt, count: attachment.count + 1 }
    socket.serializeAttachment(next)
    return next.count <= RATE_LIMIT_MESSAGES
  }
}
