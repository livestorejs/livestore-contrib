/**
 * HTTPS replica of the Unix-socket BotControlClient facade: one authenticated
 * POST per operation to the Cloudflare admin plane, decoding the exact
 * ControlResult JSON shapes the CLI parses today (see cf/src/admin.ts).
 */
import { Schema } from 'effect'

import type { Snowflake } from './model.ts'

/** Mirrors src/control/schema.ts `ControlResult`. */
const AdminControlResult = Schema.Struct({
  _tag: Schema.Literals(['Success', 'AlreadySatisfied', 'Planned', 'Unrun']),
  summary: Schema.Trimmed.check(Schema.isNonEmpty()),
  correlationId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  receiptId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  nextCommand: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
})

export type AdminControlResult = typeof AdminControlResult.Type

export interface HttpsBotControlClient {
  /** POSTs ThreadCreate to `<endpoint>/admin/rpc/ThreadCreate`. */
  readonly threadCreate: (input: {
    readonly guildId: Snowflake
    readonly channelId: Snowflake
    readonly sourceMessageId: Snowflake
    readonly reason: string
  }) => Promise<AdminControlResult>
}

const controlErrorTags = new Set([
  'InvalidControlInput',
  'ControlAuthorizationRejected',
  'ControlDependencyUnavailable',
  'ControlApplicationFailure',
  'ControlAmbiguousOutcome',
  'ControlGateUnrun',
])

const describeErrorBody = (status: number, body: string): string => {
  try {
    const decoded: unknown = JSON.parse(body)
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      '_tag' in decoded &&
      typeof decoded._tag === 'string' &&
      controlErrorTags.has(decoded._tag) === true
    ) {
      const message = 'message' in decoded && typeof decoded.message === 'string' ? decoded.message : ''
      return `${decoded._tag}${message === '' ? '' : `: ${message}`}`
    }
  } catch {
    // fall through to the status-only description
  }
  return `admin plane responded ${status}`
}

/**
 * The token has exactly one admitted source: the inherited environment
 * populated by the approved wrapper; it is never accepted as a CLI argument.
 */
export const makeHttpsBotControlClient = (input: {
  readonly endpoint: string
  readonly adminToken: string
  readonly fetch?: typeof globalThis.fetch
}): HttpsBotControlClient => {
  const base = input.endpoint.endsWith('/') === true ? input.endpoint.slice(0, -1) : input.endpoint
  const doFetch = input.fetch ?? globalThis.fetch
  return {
    threadCreate: async ({ guildId, channelId, sourceMessageId, reason }) => {
      let response: Response
      try {
        response = await doFetch(`${base}/admin/rpc/ThreadCreate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${input.adminToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            source: { guildId, channelId, messageId: sourceMessageId },
            environment: 'staging',
            apply: true,
            reason,
          }),
        })
      } catch {
        throw new Error('Admin plane is unreachable')
      }
      const body = await response.text()
      if (response.ok === true) {
        try {
          return Schema.decodeUnknownSync(AdminControlResult)(JSON.parse(body))
        } catch {
          throw new Error('Admin plane returned an invalid ControlResult')
        }
      }
      throw new Error(describeErrorBody(response.status, body))
    },
  }
}
