import type * as Effect from 'effect/Effect'
import { Schema } from 'effect'

/**
 * Portable docs-state schema: the exact schemas and store contract from
 * `state.ts`, split out so node-free hosts (Cloudflare worker) can decode and
 * persist the same on-disk document without importing this module's
 * node-builtins sibling (`state.ts` reads/writes files). The schema is
 * value-identical; `state.ts` re-exports everything here.
 */
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Correlation = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const AnswerProvenance = Schema.Struct({
  correlation: Correlation,
  atMillis: NonNegativeInt,
  corpusDigest: Schema.String,
  engineConfiguration: Schema.String,
  sourceCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  estimatedCostUsdMicros: NonNegativeInt,
})
export type AnswerProvenance = typeof AnswerProvenance.Type

export const DocsQuotaSample = Schema.Struct({
  atMillis: NonNegativeInt,
  principal: Correlation,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  costUsdMicros: NonNegativeInt,
})
export type DocsQuotaSample = typeof DocsQuotaSample.Type

export const StateFile = Schema.Struct({
  version: Schema.Literal(1),
  provenance: Schema.Array(AnswerProvenance),
  quota: Schema.Array(DocsQuotaSample),
  monthly: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      atMillis: NonNegativeInt,
      costUsdMicros: NonNegativeInt,
      status: Schema.Literals(['reserved', 'charged', 'cancelled']),
    }),
  ),
})
export type StateFile = typeof StateFile.Type

export type MonthlyReservation = { readonly _tag: 'Reserved'; readonly id: string } | { readonly _tag: 'Denied' }

export interface DocsStateStore {
  readonly record: (input: {
    readonly provenance: AnswerProvenance
    readonly quota: DocsQuotaSample
  }) => Effect.Effect<void>
  readonly recent: (nowMillis: number) => Effect.Effect<StateFile>
  readonly monthlySpent: (nowMillis: number) => Effect.Effect<number>
  /** Atomically reserves the worst-case cost before a provider request. */
  readonly reserveMonthly: (input: {
    readonly atMillis: number
    readonly costUsdMicros: number
    readonly ceilingUsdMicros: number
  }) => Effect.Effect<MonthlyReservation>
  /** Settles a reservation; unknown provider usage deliberately keeps its reservation. */
  readonly settleMonthly: (input: {
    readonly id: string
    readonly outcome: 'cancel' | 'charge'
    readonly costUsdMicros?: number
  }) => Effect.Effect<void>
}
