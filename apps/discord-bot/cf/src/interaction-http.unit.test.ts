import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'

import { receiveDiscordInteraction } from './interaction-http.ts'

const receive = (...args: Parameters<typeof receiveDiscordInteraction<never>>) =>
  Effect.runPromise(receiveDiscordInteraction(...args))

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

const signRequest = async (body: string, at = Date.now()) => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  if ('privateKey' in keys === false) throw new Error('Expected an Ed25519 key pair')
  const timestamp = String(Math.floor(at / 1_000))
  const signature = toHex(
    await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body)),
  )
  const exported = await crypto.subtle.exportKey('raw', keys.publicKey)
  if (exported instanceof ArrayBuffer === false) throw new Error('Expected the raw public key')
  const publicKey = toHex(exported)
  return {
    publicKey,
    request: (wireBody = body) =>
      new Request('https://bot.example/discord/interactions', {
        method: 'POST',
        headers: { 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature },
        body: wireBody,
      }),
  }
}

describe('signed Discord interaction ingress', () => {
  it('answers signed PING inline without entering the Durable Object', async () => {
    const { request, publicKey } = await signRequest('{ "type": 1 }')
    const acknowledge = vi.fn(() => Effect.succeed(true))
    const response = await receive(request(), publicKey, acknowledge)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 1 })
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('checks the exact bytes and rejects stale signatures', async () => {
    const fresh = await signRequest('{ "type": 2, "text": "naïve" }')
    const stale = await signRequest('{ "type": 2 }', Date.now() - 6 * 60_000)
    const acknowledge = vi.fn(() => Effect.succeed(true))
    const modified = await receive(fresh.request('{"type":2,"text":"naïve"}'), fresh.publicKey, acknowledge)
    const replayed = await receive(stale.request(), stale.publicKey, acknowledge)
    expect([modified.status, replayed.status]).toEqual([401, 401])
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('returns an empty 202 only after the callback reports acknowledgment', async () => {
    const { request, publicKey } = await signRequest('{"type":2}')
    const acknowledge = vi.fn(() => Effect.succeed(true))
    const accepted = await receive(request(), publicKey, acknowledge)
    expect(accepted.status).toBe(202)
    expect(await accepted.text()).toBe('')
    expect(acknowledge).toHaveBeenCalledWith({ type: 2 })
    const unavailable = await receive(request(), publicKey, () => Effect.succeed(false))
    expect(unavailable.status).toBe(503)
  })
})
