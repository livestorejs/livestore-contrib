import { createHmac, randomBytes } from 'node:crypto'
import { Effect, Schema } from 'effect'

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const maximumRetainedWindowMillis = 24 * 60 * 60 * 1_000

export const DocsAdmissionLimits = Schema.Struct({
  maximumConcurrentPerPrincipal: PositiveInt,
  maximumConcurrentGlobal: PositiveInt,
  maximumRequestsPerPrincipalWindow: PositiveInt,
  principalRequestWindowMillis: PositiveInt.check(
    Schema.isLessThanOrEqualTo(maximumRetainedWindowMillis),
  ),
  maximumRequestsGlobalWindow: PositiveInt,
  globalRequestWindowMillis: PositiveInt.check(
    Schema.isLessThanOrEqualTo(maximumRetainedWindowMillis),
  ),
  maximumInputTokensPerRequest: PositiveInt,
  maximumOutputTokensPerRequest: PositiveInt,
  maximumTokensPerPrincipalWindow: PositiveInt,
  maximumTokensGlobalWindow: PositiveInt,
  tokenWindowMillis: PositiveInt.check(Schema.isLessThanOrEqualTo(maximumRetainedWindowMillis)),
}).annotate({ identifier: 'DiscordBot.Docs.AdmissionLimits' })
export type DocsAdmissionLimits = typeof DocsAdmissionLimits.Type

/** Projects deployment OpenAI ceilings into the request admission boundary. */
export const docsAdmissionLimitsFromDeployment = (limits: {
  readonly requestsPerMemberPerHour: number
  readonly requestsPerMinute: number
  readonly inputTokensPerRequest: number
  readonly outputTokensPerRequest: number
}) => Schema.decodeUnknownSync(DocsAdmissionLimits)({
  ...defaultDocsAdmissionLimits,
  maximumRequestsPerPrincipalWindow: limits.requestsPerMemberPerHour,
  maximumRequestsGlobalWindow: Math.max(1, limits.requestsPerMinute),
  maximumInputTokensPerRequest: limits.inputTokensPerRequest,
  maximumOutputTokensPerRequest: limits.outputTokensPerRequest,
})

export const defaultDocsAdmissionLimits = Schema.decodeUnknownSync(DocsAdmissionLimits)({
  maximumConcurrentPerPrincipal: 1,
  maximumConcurrentGlobal: 4,
  maximumRequestsPerPrincipalWindow: 10,
  principalRequestWindowMillis: 60 * 60 * 1_000,
  maximumRequestsGlobalWindow: 60,
  globalRequestWindowMillis: 60 * 1_000,
  maximumInputTokensPerRequest: 40_000,
  maximumOutputTokensPerRequest: 2_000,
  maximumTokensPerPrincipalWindow: 100_000,
  maximumTokensGlobalWindow: 1_000_000,
  tokenWindowMillis: maximumRetainedWindowMillis,
})

export const correlateWithKey = (key: Uint8Array | string, value: string) =>
  createHmac('sha256', key).update(value).digest('hex')

export const DocsAdmissionDenialReason = Schema.Literals([
  'input_too_large',
  'principal_concurrency',
  'global_concurrency',
  'principal_rate',
  'global_rate',
  'principal_tokens',
  'global_tokens',
  'monthly_cost',
])
export type DocsAdmissionDenialReason = typeof DocsAdmissionDenialReason.Type

export type DocsAdmissionDecision =
  | { readonly _tag: 'Denied'; readonly reason: DocsAdmissionDenialReason }
  | {
      readonly _tag: 'Admitted'
      /** Idempotently releases reservations and records only content-free provider usage. */
      readonly complete: (usage?: DocsAdmissionUsage) => Effect.Effect<void>
    }

export interface DocsAdmissionUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface DocsAdmissionService {
  readonly acquire: (input: {
    readonly principalId: string
    readonly estimatedInputTokens: number
  }) => Effect.Effect<DocsAdmissionDecision>
}

export interface DocsAdmissionOptions {
  readonly limits?: DocsAdmissionLimits
  readonly now?: () => number
  /** Test seam; production always uses an ephemeral keyed HMAC correlation. */
  readonly correlatePrincipal?: (principalId: string) => string
  /** A deployment-projected key; production must provide this from a secret file. */
  readonly correlationKey?: Uint8Array | string
}

/**
 * Makes one process-local admission boundary. State contains only one-way correlations,
 * counters, and timestamps, and is pruned within the configured (maximum 24-hour) windows.
 */
export const makeDocsAdmission = (options: DocsAdmissionOptions = {}): DocsAdmissionService => {
  const limits = options.limits ?? defaultDocsAdmissionLimits
  const now = options.now ?? Date.now
  const correlationKey = options.correlationKey ?? randomBytes(32)
  const correlatePrincipal = options.correlatePrincipal ??
    ((principalId: string) => createHmac('sha256', correlationKey).update(principalId).digest('hex'))
  const principals = new Map<string, PrincipalState>()
  const globalState: MutableAdmissionState = { inFlight: 0, reservedTokens: 0, requestTimes: [], tokenSamples: [] }

  const acquire = Effect.fn('docs.admission.acquire')(function* (input: {
    readonly principalId: string
    readonly estimatedInputTokens: number
  }) {
    return yield* Effect.sync((): DocsAdmissionDecision => {
      const at = now()
      const principalKey = correlatePrincipal(input.principalId)
      const principal = principals.get(principalKey) ?? {
        inFlight: 0,
        reservedTokens: 0,
        requestTimes: [],
        tokenSamples: [],
      }
      principals.set(principalKey, principal)
      prune(principal, at, limits.principalRequestWindowMillis, limits.tokenWindowMillis)
      prune(globalState, at, limits.globalRequestWindowMillis, limits.tokenWindowMillis)

      const reservedTokens = input.estimatedInputTokens + limits.maximumOutputTokensPerRequest
      const denial = assessAdmission(input.estimatedInputTokens, reservedTokens, principal, globalState, limits)
      if (denial !== undefined) {
        if (isEmpty(principal) === true) principals.delete(principalKey)
        return { _tag: 'Denied', reason: denial }
      }

      principal.inFlight += 1
      principal.reservedTokens += reservedTokens
      principal.requestTimes.push(at)
      globalState.inFlight += 1
      globalState.reservedTokens += reservedTokens
      globalState.requestTimes.push(at)

      let completed = false
      return {
        _tag: 'Admitted',
        complete: usage => Effect.sync(() => {
          if (completed === true) return
          completed = true
          const completedAt = now()
          // Unknown usage is charged at the full reservation so post-submit failures cannot bypass ceilings.
          const actualTokens = usage === undefined
            ? reservedTokens
            : Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens)
          principal.inFlight -= 1
          principal.reservedTokens -= reservedTokens
          principal.tokenSamples.push({ at: completedAt, tokens: actualTokens })
          globalState.inFlight -= 1
          globalState.reservedTokens -= reservedTokens
          globalState.tokenSamples.push({ at: completedAt, tokens: actualTokens })
          prune(principal, completedAt, limits.principalRequestWindowMillis, limits.tokenWindowMillis)
          prune(globalState, completedAt, limits.globalRequestWindowMillis, limits.tokenWindowMillis)
          if (isEmpty(principal) === true) {
            principals.delete(principalKey)
          }
        }),
      }
    })
  })

  return { acquire }
}

interface TokenSample {
  readonly at: number
  readonly tokens: number
}

interface MutableAdmissionState {
  inFlight: number
  reservedTokens: number
  requestTimes: Array<number>
  tokenSamples: Array<TokenSample>
}

type PrincipalState = MutableAdmissionState

const assessAdmission = (
  estimatedInputTokens: number,
  reservedTokens: number,
  principal: PrincipalState,
  global: MutableAdmissionState,
  limits: DocsAdmissionLimits,
): DocsAdmissionDenialReason | undefined => {
  if (estimatedInputTokens > limits.maximumInputTokensPerRequest) return 'input_too_large'
  if (principal.inFlight >= limits.maximumConcurrentPerPrincipal) return 'principal_concurrency'
  if (global.inFlight >= limits.maximumConcurrentGlobal) return 'global_concurrency'
  if (principal.requestTimes.length >= limits.maximumRequestsPerPrincipalWindow) return 'principal_rate'
  if (global.requestTimes.length >= limits.maximumRequestsGlobalWindow) return 'global_rate'
  if (tokenTotal(principal) + principal.reservedTokens + reservedTokens > limits.maximumTokensPerPrincipalWindow) {
    return 'principal_tokens'
  }
  if (tokenTotal(global) + global.reservedTokens + reservedTokens > limits.maximumTokensGlobalWindow) {
    return 'global_tokens'
  }
  return undefined
}

const prune = (
  state: MutableAdmissionState,
  at: number,
  requestWindowMillis: number,
  tokenWindowMillis: number,
) => {
  state.requestTimes = state.requestTimes.filter(timestamp => timestamp > at - requestWindowMillis)
  state.tokenSamples = state.tokenSamples.filter(sample => sample.at > at - tokenWindowMillis)
}

const tokenTotal = (state: MutableAdmissionState) =>
  state.tokenSamples.reduce((sum, sample) => sum + sample.tokens, 0)

const isEmpty = (state: MutableAdmissionState) =>
  state.inFlight === 0 && state.requestTimes.length === 0 && state.tokenSamples.length === 0
