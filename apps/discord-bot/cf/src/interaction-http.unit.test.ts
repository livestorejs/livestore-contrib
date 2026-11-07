import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'

import { DiscordActionError } from '../../src/discord/actions.ts'
import { observeDiscordCallback, receiveDiscordInteraction } from './interaction-http.ts'

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
    const command = { type: 2, channel_id: '100000000000000001' }
    const { request, publicKey } = await signRequest(JSON.stringify(command))
    const acknowledge = vi.fn(() => Effect.succeed(true))
    const accepted = await receive(request(), publicKey, acknowledge)
    expect(accepted.status).toBe(202)
    expect(await accepted.text()).toBe('')
    expect(acknowledge).toHaveBeenCalledWith(command)
    const unavailable = await receive(request(), publicKey, () => Effect.succeed(false))
    expect(unavailable.status).toBe(503)
  })
})

it('normalizes a signed channel object and rejects disagreeing or missing channel IDs', async () => {
  const command = { type: 2, channel: { id: '100000000000000001' } }
  const nested = await signRequest(JSON.stringify(command))
  const conflicting = await signRequest(JSON.stringify({ ...command, channel_id: '100000000000000002' }))
  const missing = await signRequest('{"type":2}')
  const acknowledge = vi.fn(() => Effect.succeed(true))
  expect((await receive(nested.request(), nested.publicKey, acknowledge)).status).toBe(202)
  expect((await receive(conflicting.request(), conflicting.publicKey, acknowledge)).status).toBe(400)
  expect((await receive(missing.request(), missing.publicKey, acknowledge)).status).toBe(400)
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith({ ...command, channel_id: command.channel.id })
})

it('acknowledges a Discord 40060 retry without running the command continuation', async () => {
  const observe = vi.fn()
  const runCommand = vi.fn()
  const callbackError = new DiscordActionError({
    operation: 'defer-interaction',
    message: 'Duplicate callback',
    cause: Object.assign(new Error('Already acknowledged'), {
      name: 'DiscordRestError',
      _tag: 'ErrorResponse',
      response: { status: 400 },
      data: { code: 40060 },
    }),
  })
  const result = await Effect.runPromise(
    observeDiscordCallback(Effect.fail(callbackError), Effect.sync(observe)).pipe(
      Effect.andThen(Effect.sync(runCommand)),
      Effect.flip,
    ),
  )
  expect(result).toBe(callbackError)
  expect(observe).toHaveBeenCalledOnce()
  expect(runCommand).not.toHaveBeenCalled()
})
