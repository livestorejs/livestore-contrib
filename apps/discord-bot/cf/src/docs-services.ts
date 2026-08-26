import { Array as Arr, Effect, Layer, Redacted, Result, Schema } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'

import {
  type DocsQueryInput,
  type DocsQueryResult,
  DocsTelemetryEvent,
  type DocsOutcome,
  type DocumentationSnapshot,
} from '../../src/docs/domain.ts'
import {
  estimateOpenAiRequestTokenUpperBound,
  lunaCostUsdMicros,
  makeOpenAiAnswerEngineLayer,
} from '../../src/docs/openai.ts'
import { selectDocumentationSources } from '../../src/docs/retrieval.ts'
import { AnswerEngine, DocsTelemetry, DocsWorkflow, DocumentationCorpus } from '../../src/docs/services.ts'
import { makeCanonicalCorpusLayer } from '../../src/docs/corpus.ts'

import { makeCrypto, type CryptoService } from './crypto.ts'

// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------

/**
 * Assembles the docs workflow chain for the Cloudflare worker. The upstream
 * modules `src/docs/admission.ts`, `src/docs/workflow.ts` and
 * `src/docs/state.ts` statically import `node:` builtins, and the worker
 * bundle invariant (cf/src/bundle-check.unit.test.ts, nodejs_compat OFF)
 * forbids every `node:` specifier in the worker dependency graph. This module
 * therefore re-implements the admission boundary and the workflow assembly on
 * the WebCrypto surface (`./crypto.ts`, local HMAC) and reuses only the
 * already-portable pieces of the chain (`corpus.ts`, `openai.ts`,
 * `retrieval.ts`, `domain.ts`, `services.ts`).
 */

// ---------------------------------------------------------------------------
// Admission limits (port of src/docs/admission.ts schemas — kept value-identical)
// ---------------------------------------------------------------------------

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const maximumRetainedWindowMillis = 24 * 60 * 60 * 1_000

export const DocsAdmissionLimits = Schema.Struct({
  maximumConcurrentPerPrincipal: PositiveInt,
  maximumConcurrentGlobal: PositiveInt,
  maximumRequestsPerPrincipalWindow: PositiveInt,
  principalRequestWindowMillis: PositiveInt.check(Schema.isLessThanOrEqualTo(maximumRetainedWindowMillis)),
  maximumRequestsGlobalWindow: PositiveInt,
  globalRequestWindowMillis: PositiveInt.check(Schema.isLessThanOrEqualTo(maximumRetainedWindowMillis)),
  maximumInputTokensPerRequest: PositiveInt,
  maximumOutputTokensPerRequest: PositiveInt,
  maximumTokensPerPrincipalWindow: PositiveInt,
  maximumTokensGlobalWindow: PositiveInt,
  tokenWindowMillis: PositiveInt.check(Schema.isLessThanOrEqualTo(maximumRetainedWindowMillis)),
}).annotate({ identifier: 'DiscordBot.Docs.Worker.AdmissionLimits' })
export type DocsAdmissionLimits = typeof DocsAdmissionLimits.Type

/** Value-identical with src/docs/admission.ts defaultDocsAdmissionLimits. */
export const defaultWorkerDocsAdmissionLimits = Schema.decodeUnknownSync(DocsAdmissionLimits)({
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

export interface DeploymentOpenAiLimits {
  readonly requestsPerMemberPerHour: number
  readonly requestsPerMinute: number
  readonly inputTokensPerRequest: number
  readonly outputTokensPerRequest: number
}

/** Projects deployment OpenAI ceilings into the request admission boundary. */
export const workerDocsAdmissionLimitsFromDeployment = (limits: DeploymentOpenAiLimits): DocsAdmissionLimits =>
  Schema.decodeUnknownSync(DocsAdmissionLimits)({
    ...defaultWorkerDocsAdmissionLimits,
    maximumRequestsPerPrincipalWindow: limits.requestsPerMemberPerHour,
    maximumRequestsGlobalWindow: Math.max(1, limits.requestsPerMinute),
    maximumInputTokensPerRequest: limits.inputTokensPerRequest,
    maximumOutputTokensPerRequest: limits.outputTokensPerRequest,
  })

export type DocsAdmissionDenialReason =
  | 'input_too_large'
  | 'principal_concurrency'
  | 'global_concurrency'
  | 'principal_rate'
  | 'global_rate'
  | 'principal_tokens'
  | 'global_tokens'
  | 'monthly_cost'

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

// ---------------------------------------------------------------------------
// Correlation over WebCrypto
// ---------------------------------------------------------------------------

class WorkerCorrelationFailure extends Schema.TaggedError<WorkerCorrelationFailure>()('WorkerCorrelationFailure', {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}
/**
 * Keyed one-way correlation with runtime parity to node's
 * `correlateWithKey(createHmac('sha256', …))`, resolved through WebCrypto so
 * no `node:` builtin enters the worker graph.
 */
export const correlateWithWebCryptoKey = (
  key: Uint8Array | string,
  value: string,
): Effect.Effect<string, WorkerCorrelationFailure> =>
  Effect.tryPromise({
    try: async () => {
      const encoded = new TextEncoder()
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        typeof key === 'string' ? encoded.encode(key) : key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoded.encode(value))
      return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: (cause) => new WorkerCorrelationFailure({ operation: 'correlateWithWebCryptoKey', cause }),
  })


// ---------------------------------------------------------------------------
// Persistent state store contract (structural port of src/docs/state.ts types)
// ---------------------------------------------------------------------------

/** Structural twin of `AnswerProvenance` in src/docs/state.ts; assignability is preserved. */
export interface DocsAnswerProvenance {
  readonly correlation: string
  readonly atMillis: number
  readonly corpusDigest: string
  readonly engineConfiguration: string
  readonly sourceCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsdMicros: number
}

/** Structural twin of `DocsQuotaSample` in src/docs/state.ts. */
export interface DocsQuotaSampleRecord {
  readonly atMillis: number
  readonly principal: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsdMicros: number
}

export type DocsMonthlyReservation =
  | { readonly _tag: 'Reserved'; readonly id: string }
  | { readonly _tag: 'Denied' }

export interface DocsStateFile {
  readonly version: 1
  readonly provenance: ReadonlyArray<DocsAnswerProvenance>
  readonly quota: ReadonlyArray<DocsQuotaSampleRecord>
  readonly monthly: ReadonlyArray<{
    readonly id: string
    readonly atMillis: number
    readonly costUsdMicros: number
    readonly status: 'reserved' | 'charged' | 'cancelled'
  }>
}

/**
 * Structural twin of the `DocsStateStore` interface from src/docs/state.ts so
 * the CF module never imports that node-tainted file. The integrator passes
 * `makeKeyValueDocsStateStore(…)` from ./docs-state.ts, which satisfies it
 * structurally.
 */
export interface DocsStateStore {
  readonly record: (input: {
    readonly provenance: DocsAnswerProvenance
    readonly quota: DocsQuotaSampleRecord
  }) => Effect.Effect<void>
  readonly recent: (nowMillis: number) => Effect.Effect<DocsStateFile>
  readonly monthlySpent: (nowMillis: number) => Effect.Effect<number>
  /** Atomically reserves the worst-case cost before a provider request. */
  readonly reserveMonthly: (input: {
    readonly atMillis: number
    readonly costUsdMicros: number
    readonly ceilingUsdMicros: number
  }) => Effect.Effect<DocsMonthlyReservation>
  /** Settles a reservation; unknown provider usage deliberately keeps its reservation. */
  readonly settleMonthly: (input: {
    readonly id: string
    readonly outcome: 'cancel' | 'charge'
    readonly costUsdMicros?: number
  }) => Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Crypto-backed admission boundary (port of makeDocsAdmission)
// ---------------------------------------------------------------------------

export interface DocsAdmissionOptions {
  readonly limits?: DocsAdmissionLimits | undefined
  readonly now?: () => number
  /**
   * One-way principal correlation. Unlike the node original there is no
   * implicit default here: callers always supply it (HMAC over a deployment
   * key or an ephemeral random key resolved before construction).
   */
  readonly correlatePrincipal: (principalId: string) => Effect.Effect<string>
}

export interface DocsAdmissionService {
  readonly acquire: (input: {
    readonly principalId: string
    readonly estimatedInputTokens: number
  }) => Effect.Effect<DocsAdmissionDecision>
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

const prune = (state: MutableAdmissionState, at: number, requestWindowMillis: number, tokenWindowMillis: number) => {
  state.requestTimes = state.requestTimes.filter((timestamp) => timestamp > at - requestWindowMillis)
  state.tokenSamples = state.tokenSamples.filter((sample) => sample.at > at - tokenWindowMillis)
}

const tokenTotal = (state: MutableAdmissionState) => state.tokenSamples.reduce((sum, sample) => sum + sample.tokens, 0)

const isEmpty = (state: MutableAdmissionState) =>
  state.inFlight === 0 && state.requestTimes.length === 0 && state.tokenSamples.length === 0

/**
 * Makes one DO-local admission boundary. State contains only one-way
 * correlations, counters, and timestamps, and is pruned within the configured
 * (maximum 24-hour) windows.
 */
export const makeCryptoDocsAdmission = (options: DocsAdmissionOptions): DocsAdmissionService => {
  const limits = options.limits ?? defaultWorkerDocsAdmissionLimits
  const now = options.now ?? Date.now
  const emptyState = (): MutableAdmissionState => ({ inFlight: 0, reservedTokens: 0, requestTimes: [], tokenSamples: [] })
  const principals = new Map<string, PrincipalState>()
  const globalState = emptyState()

  const acquire = Effect.fn('docs.admission.acquire')(function* (input: {
    readonly principalId: string
    readonly estimatedInputTokens: number
  }) {
    const principalKey = yield* options.correlatePrincipal(input.principalId)
    return yield* Effect.sync((): DocsAdmissionDecision => {
      const at = now()
      const principal = principals.get(principalKey) ?? emptyState()
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
        complete: (usage) =>
          Effect.sync(() => {
            if (completed === true) return
            completed = true
            const completedAt = now()
            // Unknown usage is charged at the full reservation so post-submit failures cannot bypass ceilings.
            const actualTokens =
              usage === undefined ? reservedTokens : Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens)
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

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Workers have no filesystem for the node telemetry fallback; content-free
 * events go to the structured console logger instead.
 */
export const makeConsoleDocsTelemetry = (): DocsTelemetry['Service'] => ({
  emit: (event: DocsTelemetryEvent) =>
    Effect.logDebug('docs telemetry').pipe(Effect.annotateLogs({ ...event })),
})

// ---------------------------------------------------------------------------
// Workflow layer (port of makeDocsWorkflowLayer with WebCrypto correlations)
// ---------------------------------------------------------------------------

export interface DocsWorkflowOptions {
  readonly limits?: DocsAdmissionLimits | undefined
  readonly monthlyCostUsdMicros?: number | undefined
  readonly stateStore?: DocsStateStore | undefined
  /** A deployment-projected key; production must provide this from a secret. Omitted: an ephemeral per-instance key is generated. */
  readonly correlationKey?: Uint8Array | string | undefined
}

const unavailable = (
  reason: Extract<DocsQueryResult, { readonly _tag: 'Unavailable' }>['reason'],
): DocsQueryResult => ({
  _tag: 'Unavailable',
  reason,
})

export const makeCryptoDocsWorkflowLayer = (options: DocsWorkflowOptions = {}) =>
  Layer.effect(
    DocsWorkflow,
    Effect.gen(function* () {
      const corpus = yield* DocumentationCorpus
      const engine = yield* AnswerEngine
      const telemetry = yield* DocsTelemetry
      const crypto: CryptoService = makeCrypto()
      // Ephemeral keys are generated per layer build so a DO wake without a
      // configured secret still gets unique one-way correlations.
      const correlationKey = options.correlationKey ?? (yield* crypto.randomBytes(32).pipe(Effect.orDie))
      // HMAC failures are WebCrypto defects, not request outcomes; they die
      // like the node original's infallible synchronous digests would.
      const correlateValue = (value: string) => correlateWithWebCryptoKey(correlationKey, value).pipe(Effect.orDie)
      const admission = makeCryptoDocsAdmission({
        limits: options.limits,
        correlatePrincipal: (principalId) => correlateValue(principalId),
      })
      const stateStore = options.stateStore
      const monthlyCostUsdMicros = options.monthlyCostUsdMicros

      const query = Effect.fn('docs.workflow.query')(function* (input: DocsQueryInput) {
        const normalizedQuery = input.query.trim()
        if (normalizedQuery.length === 0) {
          yield* telemetry.emit(event(input, 'invalid_query'))
          return unavailable('invalid_query')
        }

        const snapshotResult = yield* corpus
          .snapshot(input.refreshCorpus === undefined ? {} : { refresh: input.refreshCorpus })
          .pipe(Effect.result)
        if (Result.isFailure(snapshotResult) === true) {
          yield* telemetry.emit(event(input, 'corpus_unavailable'))
          return unavailable('corpus_unavailable')
        }
        const { cacheStatus, snapshot } = snapshotResult.success
        const sources = selectDocumentationSources(snapshot, normalizedQuery)
        const estimatedInputTokens = estimateOpenAiRequestTokenUpperBound({
          query: normalizedQuery,
          corpusDigest: snapshot.digest,
          sources,
        })
        const monthlyReservation =
          stateStore !== undefined && monthlyCostUsdMicros !== undefined
            ? yield* stateStore.reserveMonthly({
                atMillis: Date.now(),
                costUsdMicros:
                  lunaCostUsdMicros({
                    inputTokens: estimatedInputTokens,
                    outputTokens: (options.limits ?? defaultWorkerDocsAdmissionLimits).maximumOutputTokensPerRequest,
                  }),
                ceilingUsdMicros: monthlyCostUsdMicros,
              })
            : undefined
        if (monthlyReservation?._tag === 'Denied') {
          yield* telemetry.emit(
            event(
              input,
              'admission_denied',
              snapshot,
              cacheStatus,
              engine.configurationIdentity,
              sources.length,
              undefined,
              'monthly_cost',
            ),
          )
          return unavailable('admission_denied')
        }
        const admissionDecision = yield* admission.acquire({
          principalId: input.principalId ?? input.surface,
          estimatedInputTokens,
        })
        if (admissionDecision._tag === 'Denied') {
          if (monthlyReservation?._tag === 'Reserved' && stateStore !== undefined) {
            yield* stateStore.settleMonthly({ id: monthlyReservation.id, outcome: 'cancel' })
          }
          yield* telemetry.emit(
            event(
              input,
              'admission_denied',
              snapshot,
              cacheStatus,
              engine.configurationIdentity,
              sources.length,
              undefined,
              admissionDecision.reason,
            ),
          )
          return unavailable('admission_denied')
        }

        let observedUsage: DocsAdmissionUsage | undefined
        const generated = yield* engine
          .answer({
            query: normalizedQuery,
            corpusDigest: snapshot.digest,
            sources,
          })
          .pipe(
            Effect.tap(({ usage }) =>
              Effect.sync(() => {
                observedUsage = usage
              }),
            ),
            Effect.result,
            Effect.ensuring(
              Effect.suspend(() =>
                Effect.all([
                  admissionDecision.complete(observedUsage),
                  monthlyReservation?._tag === 'Reserved' && stateStore !== undefined
                    ? stateStore.settleMonthly(
                        observedUsage === undefined
                          ? { id: monthlyReservation.id, outcome: 'charge' }
                          : {
                              id: monthlyReservation.id,
                              outcome: 'charge',
                              costUsdMicros: lunaCostUsdMicros(observedUsage),
                            },
                      )
                    : Effect.void,
                ]),
              ),
            ),
          )

        if (Result.isFailure(generated) === true) {
          yield* telemetry.emit(
            event(input, 'provider_unavailable', snapshot, cacheStatus, engine.configurationIdentity, sources.length),
          )
          return unavailable('provider_unavailable')
        }

        const { candidate, usage } = generated.success
        if (hasValidCandidateShape(candidate) === false) {
          yield* telemetry.emit(
            event(
              input,
              'invalid_provider_output',
              snapshot,
              cacheStatus,
              engine.configurationIdentity,
              sources.length,
              usage,
            ),
          )
          return unavailable('invalid_provider_output')
        }
        if (candidate.supported === false) {
          yield* telemetry.emit(
            event(input, 'unsupported', snapshot, cacheStatus, engine.configurationIdentity, sources.length, usage),
          )
          return {
            _tag: 'Unsupported',
            explanation: candidate.answer,
            corpusDigest: snapshot.digest,
            engineConfiguration: engine.configurationIdentity,
          } satisfies DocsQueryResult
        }

        const byId = new Map(sources.map((source) => [source.id, source]))
        if (candidate.citations.some((citation) => !byId.has(citation)) === true) {
          yield* telemetry.emit(
            event(
              input,
              'invalid_citation',
              snapshot,
              cacheStatus,
              engine.configurationIdentity,
              sources.length,
              usage,
            ),
          )
          return unavailable('invalid_citation')
        }
        const citations = candidate.citations.flatMap((id) => {
          const source = byId.get(id)
          return source === undefined ? [] : [{ id, canonicalUrl: source.canonicalUrl }]
        })
        if (Arr.isArrayNonEmpty(citations) === false) {
          yield* telemetry.emit(
            event(
              input,
              'invalid_citation',
              snapshot,
              cacheStatus,
              engine.configurationIdentity,
              sources.length,
              usage,
            ),
          )
          return unavailable('invalid_citation')
        }
        yield* telemetry.emit(
          event(input, 'answered', snapshot, cacheStatus, engine.configurationIdentity, sources.length, usage),
        )
        if (stateStore !== undefined) {
          const correlation = yield* correlateValue(
            `${input.surface}:${snapshot.digest}:${engine.configurationIdentity}:${Date.now()}`,
          )
          const quotaPrincipal = yield* correlateValue(input.principalId ?? input.surface)
          yield* stateStore.record({
            provenance: {
              correlation,
              atMillis: Date.now(),
              corpusDigest: snapshot.digest,
              engineConfiguration: engine.configurationIdentity,
              sourceCount: sources.length,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              estimatedCostUsdMicros: lunaCostUsdMicros(usage),
            },
            quota: {
              principal: quotaPrincipal,
              atMillis: Date.now(),
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsdMicros: lunaCostUsdMicros(usage),
            },
          })
        }
        return {
          _tag: 'Answered',
          answer: candidate.answer,
          citations,
          corpusDigest: snapshot.digest,
          engineConfiguration: engine.configurationIdentity,
        } satisfies DocsQueryResult
      })

      return DocsWorkflow.of({ query })
    }),
  )

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface MakeDocsServicesInput {
  /** The OPENAI_API_KEY secret value. */
  readonly openAiApiKey: string
  /**
   * Deployment-persistent correlation key (node parity: the
   * docsCorrelationKeyFile secret). Omitted, each worker isolate derives an
   * ephemeral key, so principal correlations churn across wakes.
   */
  readonly correlationKey?: Uint8Array | string | undefined
  readonly openAiLimits?: DeploymentOpenAiLimits | undefined
  readonly monthlyCostUsdMicros?: number | undefined
  /**
   * Persistent quota/provenance store — wire `makeKeyValueDocsStateStore(…)`
   * from ./docs-state.ts here. Omitted, only the in-memory admission boundary
   * guards cost.
   */
  readonly stateStore?: DocsStateStore | undefined
  /**
   * Outgoing HTTP transport; defaults to the workers fetch client. Test seam
   * for stubbing corpus and provider endpoints without real network.
   */
  readonly httpLayer?: Layer.Layer<HttpClient.HttpClient> | undefined
}

/**
 * Everything the docs interaction handler needs besides `DiscordActions`:
 * the `DocsWorkflow` service plus its corpus/engine/telemetry ports over the
 * workers fetch transport (`globalThis.fetch`). Needs no ambient context.
 */
export const makeDocsServices = (
  input: MakeDocsServicesInput,
): Layer.Layer<DocsWorkflow | DocumentationCorpus | AnswerEngine | DocsTelemetry> => {
  const ports = Layer.mergeAll(
    makeCanonicalCorpusLayer(),
    makeOpenAiAnswerEngineLayer({ apiKey: Redacted.make(input.openAiApiKey) }),
    Layer.succeed(DocsTelemetry, DocsTelemetry.of(makeConsoleDocsTelemetry())),
  ).pipe(Layer.provide(input.httpLayer ?? FetchHttpClient.layer))
  return makeCryptoDocsWorkflowLayer({
    limits:
      input.openAiLimits === undefined ? undefined : workerDocsAdmissionLimitsFromDeployment(input.openAiLimits),
    monthlyCostUsdMicros: input.monthlyCostUsdMicros,
    stateStore: input.stateStore,
    correlationKey: input.correlationKey,
  }).pipe(Layer.provideMerge(ports))
}

const hasValidCandidateShape = (candidate: {
  readonly supported: boolean
  readonly answer: string
  readonly citations: ReadonlyArray<string>
}) => {
  if (candidate.answer.trim().length === 0) return false
  if (new Set(candidate.citations).size !== candidate.citations.length) return false
  return candidate.supported === true ? candidate.citations.length > 0 : candidate.citations.length === 0
}

const event = (
  input: DocsQueryInput,
  outcome: DocsOutcome,
  snapshot?: DocumentationSnapshot,
  cacheStatus: DocsTelemetryEvent['cacheStatus'] = 'not_consulted',
  engineConfiguration?: string,
  sourceCount = 0,
  usage: { readonly inputTokens: number; readonly outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
  admissionDenial?: DocsTelemetryEvent['admissionDenial'],
): DocsTelemetryEvent => ({
  _tag: 'DocsQueryCompleted',
  surface: input.surface,
  outcome,
  cacheStatus,
  corpusDigest: snapshot?.digest,
  engineConfiguration,
  sourceCount,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  admissionDenial,
})
