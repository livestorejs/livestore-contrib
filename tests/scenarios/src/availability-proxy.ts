import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as connectTls } from 'node:tls'

import { UnknownError } from '@livestore/common'
import { Effect, type Scope } from '@livestore/utils/effect'

export interface AvailabilityProxy {
  readonly url: string
  readonly isAvailable: Effect.Effect<boolean>
  readonly setAvailable: (available: boolean) => Effect.Effect<void>
}

/**
 * Places a stable WebSocket boundary in front of a sync-cf endpoint. The local
 * side remains plain HTTP while the upstream side can be HTTP or HTTPS. Closing
 * the boundary withholds traffic on existing sockets and rejects new upgrades
 * without stopping the Worker or Durable Object.
 */
export const makeAvailabilityProxy = (
  upstreamUrl: string,
): Effect.Effect<AvailabilityProxy, UnknownError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startProxy(upstreamUrl),
      catch: (cause) => new UnknownError({ cause }),
    }),
    (proxy) => proxy.close.pipe(Effect.orDie),
  )

interface ManagedAvailabilityProxy extends AvailabilityProxy {
  readonly close: Effect.Effect<void, UnknownError>
}

const startProxy = async (upstreamUrl: string): Promise<ManagedAvailabilityProxy> => {
  const upstream = new URL(upstreamUrl)
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`Availability proxy requires an HTTP(S) upstream: ${upstreamUrl}`)
  }
  if (upstream.hostname.length === 0) throw new Error(`Availability proxy requires an upstream host: ${upstreamUrl}`)

  const upstreamPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80))
  let available = true
  const sockets = new Set<Duplex>()
  const server = createServer((_request, response) => {
    response.writeHead(available === true ? 426 : 503).end()
  })

  server.on('upgrade', (request, downstream, head) => {
    trackSocket(sockets, downstream)
    if (available === false) {
      downstream.destroy()
      return
    }

    const onConnected = (upstreamSocket: Socket) => {
      if (available === false) {
        upstreamSocket.destroy()
        downstream.destroy()
        return
      }
      upstreamSocket.write(serializeUpgradeRequest(request, upstream))
      if (head.length > 0) upstreamSocket.write(head)
      downstream.pipe(upstreamSocket)
      upstreamSocket.pipe(downstream)
    }

    let upstreamSocket: Socket
    if (upstream.protocol === 'https:') {
      upstreamSocket = connectTls(
        {
          host: upstream.hostname,
          port: upstreamPort,
          servername: upstream.hostname,
        },
        () => onConnected(upstreamSocket),
      )
    } else {
      upstreamSocket = connectTcp({ host: upstream.hostname, port: upstreamPort }, () => onConnected(upstreamSocket))
    }

    trackSocket(sockets, upstreamSocket)
    downstream.once('close', () => upstreamSocket.destroy())
    upstreamSocket.once('close', () => downstream.destroy())
  })

  await listen(server)
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server, sockets)
    throw new Error('Availability proxy did not expose a TCP address')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    isAvailable: Effect.sync(() => available),
    setAvailable: (nextAvailable) =>
      Effect.sync(() => {
        available = nextAvailable
        for (const socket of sockets) {
          if (nextAvailable === true) socket.resume()
          else socket.pause()
        }
      }),
    close: Effect.tryPromise({
      try: () => closeServer(server, sockets),
      catch: (cause) => new UnknownError({ cause }),
    }),
  }
}

const serializeUpgradeRequest = (request: IncomingMessage, upstream: URL): string => {
  const basePath = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/$/, '')
  const requestPath = request.url?.startsWith('/') === true ? request.url : `/${request.url ?? ''}`
  const lines = [`${request.method ?? 'GET'}${' '}${basePath}${requestPath} HTTP/${request.httpVersion}`]

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!
    if (name.toLowerCase() === 'host') continue
    lines.push(`${name}: ${request.rawHeaders[index + 1] ?? ''}`)
  }
  lines.push(`Host: ${upstream.host}`, '', '')
  return lines.join('\r\n')
}

const trackSocket = (sockets: Set<Duplex>, socket: Duplex): void => {
  sockets.add(socket)
  socket.on('error', () => undefined)
  socket.once('close', () => sockets.delete(socket))
}

const listen = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off('listening', onListening)
      reject(cause)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

const closeServer = (server: Server, sockets: Set<Duplex>): Promise<void> => {
  for (const socket of sockets) socket.destroy()
  return new Promise((resolve, reject) => {
    server.close((cause) => (cause === undefined ? resolve() : reject(cause)))
  })
}
