import * as Effect from 'effect/Effect'

const maxBodyBytes = 256 * 1024
const maxTimestampSkewMs = 5 * 60_000
const encoder = new TextEncoder()

const fromHex = (value: string, bytes: number): Uint8Array<ArrayBuffer> | undefined => {
  if (value.length !== bytes * 2 || /^[0-9a-f]+$/iu.test(value) === false) return undefined
  const decoded = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) decoded[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return decoded
}

const readBoundedBody = async (request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  if (request.body === null) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done === true) break
      size += chunk.value.byteLength
      if (size > maxBodyBytes) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Verify the Discord signature over the exact timestamp and body bytes before parsing JSON. */
const verifyDiscordInteraction = async (
  request: Request,
  publicKeyHex: string,
): Promise<Response | { readonly command: unknown }> => {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const timestamp = request.headers.get('X-Signature-Timestamp') ?? ''
  const signature = fromHex(request.headers.get('X-Signature-Ed25519') ?? '', 64)
  if (
    signature === undefined ||
    /^\d{10}$/u.test(timestamp) === false ||
    Math.abs(Date.now() - Number(timestamp) * 1_000) > maxTimestampSkewMs
  ) {
    return new Response(null, { status: 401 })
  }
  const key = fromHex(publicKeyHex, 32)
  if (key === undefined) return new Response(null, { status: 503 })

  let payload: unknown
  try {
    const body = await readBoundedBody(request)
    if (body === undefined) return new Response(null, { status: 413 })
    const timestampBytes = encoder.encode(timestamp)
    const signed = new Uint8Array(timestampBytes.length + body.length)
    signed.set(timestampBytes)
    signed.set(body, timestampBytes.length)
    const verifier = await crypto.subtle.importKey('raw', key, 'Ed25519', false, ['verify'])
    if ((await crypto.subtle.verify('Ed25519', verifier, signature, signed)) === false) {
      return new Response(null, { status: 401 })
    }
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body))
  } catch {
    return new Response(null, { status: 400 })
  }

  if (typeof payload !== 'object' || payload === null || 'type' in payload === false) {
    return new Response(null, { status: 400 })
  }
  if (payload.type === 1) return Response.json({ type: 1 })
  if (payload.type !== 2) return new Response(null, { status: 400 })

  return { command: payload }
}

export const receiveDiscordInteraction = <R>(
  request: Request,
  publicKeyHex: string,
  acknowledge: (payload: unknown) => Effect.Effect<boolean, never, R>,
): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const verified = yield* Effect.promise(() => verifyDiscordInteraction(request, publicKeyHex))
    if (verified instanceof Response) return verified

    // Discord allows an empty 202 once the REST callback has acknowledged the command.
    const accepted = yield* acknowledge(verified.command).pipe(Effect.catchCause(() => Effect.succeed(false)))
    return new Response(null, { status: accepted === true ? 202 : 503 })
  })
