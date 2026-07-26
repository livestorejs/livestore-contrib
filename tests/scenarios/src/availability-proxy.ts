import { createConnection, createServer, type Server, type Socket } from 'node:net'

import { UnknownError } from '@livestore/common'
import { Effect, type Scope } from '@livestore/utils/effect'

export interface AvailabilityProxy {
  readonly url: string
  readonly isAvailable: Effect.Effect<boolean>
  readonly setAvailable: (available: boolean) => Effect.Effect<void>
}

/**
 * Places a stable, protocol-agnostic TCP boundary in front of a local backend.
 * Closing the boundary withholds traffic on existing sockets and rejects new
 * connections while leaving the real backend and its persisted state untouched.
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
  const upstreamPort = Number(upstream.port)
  if (upstream.hostname.length === 0 || Number.isFinite(upstreamPort) === false || upstreamPort <= 0) {
    throw new Error(`Availability proxy requires an explicit upstream host and port: ${upstreamUrl}`)
  }

  let available = true
  const sockets = new Set<Socket>()
  const server = createServer((downstream) => {
    trackSocket(sockets, downstream)
    if (available === false) {
      downstream.destroy()
      return
    }

    const upstreamSocket = createConnection({ host: upstream.hostname, port: upstreamPort })
    trackSocket(sockets, upstreamSocket)
    downstream.pipe(upstreamSocket)
    upstreamSocket.pipe(downstream)
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

const trackSocket = (sockets: Set<Socket>, socket: Socket): void => {
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

const closeServer = (server: Server, sockets: Set<Socket>): Promise<void> => {
  for (const socket of sockets) socket.destroy()
  return new Promise((resolve, reject) => {
    server.close((cause) => (cause === undefined ? resolve() : reject(cause)))
  })
}
