import http from 'node:http'

import { expect, test } from 'vitest'

import { Effect, FetchHttpClient, HttpRouter, Layer, ManagedRuntime } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeRouter } from './providers/electric.ts'

test('an aborted HEAD readiness probe does not block server disposal', async () => {
  let upstreamRequests = 0
  const upstream = http.createServer(() => {
    upstreamRequests++
    // A proxied HEAD would remain pending and retain the request fiber from Effect #6485.
  })
  await listen(upstream)

  const server = http.createServer()
  const runtime = ManagedRuntime.make(
    Layer.effectDiscard(
      HttpRouter.serve(makeRouter({ electricPort: tcpPort(upstream), postgresPort: 1 })).pipe(
        Layer.provide(PlatformNode.NodeHttpServer.layer(() => server, { port: 0 })),
        Layer.provide(FetchHttpClient.layer),
        Layer.launch,
        Effect.forkScoped,
        Effect.asVoid,
      ),
    ),
  )

  try {
    await runtime.context()
    if (server.listening === false) await new Promise<void>((resolve) => server.once('listening', resolve))

    const responseStatus = await head(tcpPort(server))
    expect(responseStatus).toBe(204)
    expect(upstreamRequests).toBe(0)

    const requestReceived = new Promise<void>((resolve) => server.once('request', () => resolve()))
    const abortedRequest = http.request({ method: 'HEAD', port: tcpPort(server), path: '/' })
    abortedRequest.on('error', () => {})
    abortedRequest.end()
    await requestReceived
    abortedRequest.destroy()
    await new Promise<void>((resolve) => abortedRequest.once('close', resolve))

    await withTimeout(runtime.dispose(), 2_000, 'provider HTTP runtime disposal exceeded 2 seconds')
  } finally {
    server.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([close(server), close(upstream)])
  }
})

const listen = (server: http.Server): Promise<void> => new Promise((resolve) => server.listen(0, resolve))

const close = (server: http.Server): Promise<void> =>
  server.listening ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve()

const withTimeout = async <A>(promise: Promise<A>, timeoutMs: number, message: string): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

const tcpPort = (server: http.Server): number => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address')
  return address.port
}

const head = (port: number): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    const request = http.request({ method: 'HEAD', port, path: '/' }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.end()
  })
