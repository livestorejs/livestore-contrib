import * as Schema from 'effect/Schema'

import { DiscordMessageRef } from '../../src/threading/model.ts'
import { constantTimeEquals } from './admin.ts'

const receive = async <A>(input: {
  readonly maxBytes: number
  readonly decode: (payload: unknown) => A
  readonly request: Request
  readonly token: string
  readonly deliver: (source: A) => Promise<boolean>
}): Promise<Response> => {
  const { request, token } = input
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const authorization = request.headers.get('authorization')
  if (token === '' || authorization === null || constantTimeEquals(authorization, `Bearer ${token}`) === false) {
    return new Response(null, { status: 401 })
  }
  if (request.body === null) return new Response(null, { status: 400 })
  const reader = request.body.getReader()
  const buffer = new Uint8Array(input.maxBytes)
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done === true) break
      if (size + chunk.value.byteLength > buffer.byteLength) {
        await reader.cancel().catch(() => undefined)
        return new Response(null, { status: 413 })
      }
      buffer.set(chunk.value, size)
      size += chunk.value.byteLength
    }
  } catch {
    return new Response(null, { status: 400 })
  } finally {
    reader.releaseLock()
  }

  let source: A
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, size)),
    )
    source = input.decode(payload)
  } catch {
    return new Response(null, { status: 400 })
  }

  const settled = await input.deliver(source).catch(() => false)
  return new Response(null, { status: settled === true ? 204 : 503 })
}

/** The relay credential grants no admin access. */
export const receiveRelayMessage = (input: {
  readonly request: Request
  readonly token: string
  readonly deliver: (source: DiscordMessageRef) => Promise<boolean>
}) =>
  receive({
    ...input,
    maxBytes: 1024,
    decode: Schema.decodeUnknownSync(DiscordMessageRef, { onExcessProperty: 'error' }),
  })

export const receiveRelayInteraction = (input: {
  readonly request: Request
  readonly token: string
  readonly deliver: (payload: unknown) => Promise<boolean>
}) => receive({ ...input, maxBytes: 65_536, decode: (payload) => payload })

export const receiveRelayHeartbeat = (input: {
  readonly request: Request
  readonly token: string
  readonly deliver: (ready: boolean) => Promise<boolean>
}) => receive({ ...input, maxBytes: 16, decode: Schema.decodeUnknownSync(Schema.Boolean) })
