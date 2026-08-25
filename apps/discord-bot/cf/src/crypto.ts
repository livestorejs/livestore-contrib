import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

export class CryptoFailure extends Schema.TaggedError<CryptoFailure>()('CryptoFailure', {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * Runtime-agnostic randomness and hashing over the WebCrypto surface that
 * Cloudflare Workers, Bun and Node all expose on `globalThis.crypto`. The
 * worker path must never reach a Node builtin (`node:crypto`), so journal
 * claim tokens and docs correlation digests resolve through this service.
 */
export interface CryptoService {
  readonly randomUUID: Effect.Effect<string>
  /**
   * Cryptographically strong bytes; WebCrypto caps a single fill at 65_536
   * bytes, which is far above every caller's need here.
   */
  readonly randomBytes: (length: number) => Effect.Effect<Uint8Array, CryptoFailure>
  readonly sha256Hex: (data: Uint8Array | string) => Effect.Effect<string, CryptoFailure>
}
export const makeCrypto = (): CryptoService => ({
  randomUUID: Effect.sync(() => crypto.randomUUID()),
  randomBytes: (length) =>
    Effect.try({
      try: () => crypto.getRandomValues(new Uint8Array(length)),
      catch: (cause) => new CryptoFailure({ operation: 'randomBytes', cause }),
    }),
  sha256Hex: (data) =>
    Effect.tryPromise({
      // subtle.digest resolves only for supported algorithm names; 'SHA-256'
      // is part of the baseline every workers/Bun/Node runtime ships.
      try: () =>
        crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data),
      catch: (cause) => new CryptoFailure({ operation: 'sha256Hex', cause }),
    }).pipe(
      Effect.map((digest) => {
        let hex = ''
        for (const byte of new Uint8Array(digest)) {
          hex += byte.toString(16).padStart(2, '0')
        }
        return hex
      }),
    ),
})

