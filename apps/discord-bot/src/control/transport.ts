import type { Effect } from 'effect'

import type { BotControlClient } from './contract.ts'
import { ControlDependencyUnavailable } from './schema.ts'

export type UnixSocketAddress = {
  readonly _tag: 'UnixSocketAddress'
  readonly path: string
}

/**
 * Runtime-owned connection boundary. Implementations must derive the actor from
 * the peer-authenticated socket; the request model deliberately has no actor field.
 */
export interface BotControlClientFactory {
  readonly connect: (address: UnixSocketAddress) => Effect.Effect<BotControlClient, ControlDependencyUnavailable>
}

export const defaultControlSocket = (environment: 'staging' | 'production'): UnixSocketAddress => ({
  _tag: 'UnixSocketAddress',
  path: `/run/discord-bot/${environment}/control.sock`,
})
