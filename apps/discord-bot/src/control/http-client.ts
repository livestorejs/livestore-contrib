import { Effect, Schema, type Scope } from 'effect'
import { RpcClient } from 'effect/unstable/rpc'
import type { RpcGroup } from 'effect/unstable/rpc'
import type { FromServer } from 'effect/unstable/rpc/RpcMessage'

import { BotControl, type BotControlClient, type BotControlOperation } from './contract.ts'
import {
  ControlAuthorizationRejected,
  ControlDependencyUnavailable,
  ControlError,
  ControlResult,
  InvalidControlInput,
  type ControlError as ControlErrorType,
  type ControlResult as ControlResultType,
} from './schema.ts'

const decodeOptional = (schema: typeof ControlResult | typeof ControlError, value: unknown): unknown => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    return undefined
  }
}

/**
 * Authenticated HTTPS transport for the admin plane with the exact
 * `BotControlClient` interface the CLI consumes over the Unix socket: one
 * `POST {base}/admin/rpc/{Operation}` per invocation, bearer-token auth,
 * results decoded against the shared `ControlResult` schema.
 */
export const makeHttpsBotControlClient = (
  baseUrl: string,
  token: string,
): Effect.Effect<BotControlClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    let writeResponse: ((message: FromServer<RpcGroup.Rpcs<typeof BotControl>>) => Effect.Effect<void>) | undefined
    const built = yield* RpcClient.makeNoSerialization(BotControl, {
      supportsAck: false,
      onFromClient: ({ message }) => {
        if (message._tag !== 'Request') return Effect.void
        return Effect.exit(postOperation(baseUrl, token, message.tag, message.payload)).pipe(
          Effect.flatMap((exit) =>
            writeResponse === undefined
              ? Effect.die('Bot control client response channel was not initialized')
              : writeResponse({ _tag: 'Exit', clientId: 0, requestId: message.id, exit }),
          ),
        )
      },
    })
    writeResponse = built.write
    return built.client
  })

const postOperation = (
  baseUrl: string,
  token: string,
  operation: BotControlOperation,
  payload: unknown,
): Effect.Effect<ControlResultType, ControlErrorType> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        globalThis.fetch(`${baseUrl}/admin/rpc/${operation}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        }),
      catch: () =>
        new ControlDependencyUnavailable({
          dependency: 'admin-endpoint',
          message: 'Could not reach the admin endpoint',
        }),
    })

    const body: unknown = yield* Effect.promise(() => response.json().catch(() => undefined))

    if (response.ok === true) {
      const result = decodeOptional(ControlResult, body)
      if (result !== undefined) return result as ControlResultType
      return yield* Effect.fail(new InvalidControlInput({ message: 'Malformed admin response' }))
    }

    const decoded = decodeOptional(ControlError, body)
    if (decoded !== undefined) return yield* Effect.fail(decoded as ControlErrorType)
    // The admin plane always answers failures with decodable ControlError
    // bodies; these fallbacks cover proxies and outages that do not.
    if (response.status === 401) {
      return yield* Effect.fail(new ControlAuthorizationRejected({ message: 'Admin endpoint rejected the bearer token' }))
    }
    if (response.status === 404) {
      return yield* Effect.fail(new InvalidControlInput({ message: 'No such admin operation route' }))
    }
    if (response.status === 400 || response.status === 422) {
      return yield* Effect.fail(new InvalidControlInput({ message: 'Admin endpoint rejected the operation payload' }))
    }
    if (response.status >= 500) {
      return yield* Effect.fail(
        new ControlDependencyUnavailable({
          dependency: 'admin-endpoint',
          message: `Admin endpoint answered ${response.status}`,
        }),
      )
    }
    return yield* Effect.fail(new InvalidControlInput({ message: 'Malformed admin response' }))
  })
