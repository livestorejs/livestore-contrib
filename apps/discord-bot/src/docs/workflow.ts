import { createHash } from 'node:crypto'

import { Array as Arr, Effect, Layer, Result } from 'effect'

import {
  makeDocsAdmission,
  correlateWithKey,
  defaultDocsAdmissionLimits,
  type DocsAdmissionOptions,
  type DocsAdmissionUsage,
} from './admission.ts'
import type {
  DocsOutcome,
  DocsQueryInput,
  DocsQueryResult,
  DocsTelemetryEvent,
  DocumentationSnapshot,
} from './domain.ts'
import { estimateOpenAiRequestTokenUpperBound } from './openai.ts'
import { lunaCostUsdMicros } from './openai.ts'
import { selectDocumentationSources } from './retrieval.ts'
import { AnswerEngine, DocsTelemetry, DocsWorkflow, DocumentationCorpus } from './services.ts'
import type { DocsStateStore } from './state.ts'

const unavailable = (
  reason: Extract<DocsQueryResult, { readonly _tag: 'Unavailable' }>['reason'],
): DocsQueryResult => ({
  _tag: 'Unavailable',
  reason,
})

export interface DocsWorkflowOptions extends DocsAdmissionOptions {
  readonly stateStore?: DocsStateStore
  readonly estimatedCostUsdMicros?: (usage: DocsAdmissionUsage) => number
  readonly monthlyCostUsdMicros?: number
}

export const makeDocsWorkflowLayer = (admissionOptions: DocsWorkflowOptions = {}) =>
  Layer.effect(
    DocsWorkflow,
    Effect.gen(function* () {
      const corpus = yield* DocumentationCorpus
      const engine = yield* AnswerEngine
      const telemetry = yield* DocsTelemetry
      const admission = makeDocsAdmission(admissionOptions)

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
          admissionOptions.stateStore !== undefined && admissionOptions.monthlyCostUsdMicros !== undefined
            ? yield* admissionOptions.stateStore.reserveMonthly({
                atMillis: Date.now(),
                costUsdMicros:
                  admissionOptions.estimatedCostUsdMicros?.({
                    inputTokens: estimatedInputTokens,
                    outputTokens: (admissionOptions.limits ?? defaultDocsAdmissionLimits).maximumOutputTokensPerRequest,
                  }) ??
                  lunaCostUsdMicros({
                    inputTokens: estimatedInputTokens,
                    outputTokens: (admissionOptions.limits ?? defaultDocsAdmissionLimits).maximumOutputTokensPerRequest,
                  }),
                ceilingUsdMicros: admissionOptions.monthlyCostUsdMicros,
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
          estimatedInputTokens: estimateOpenAiRequestTokenUpperBound({
            query: normalizedQuery,
            corpusDigest: snapshot.digest,
            sources,
          }),
        })
        if (admissionDecision._tag === 'Denied') {
          if (monthlyReservation?._tag === 'Reserved') {
            yield* admissionOptions.stateStore!.settleMonthly({ id: monthlyReservation.id, outcome: 'cancel' })
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
                  monthlyReservation?._tag === 'Reserved'
                    ? admissionOptions.stateStore!.settleMonthly(
                        observedUsage === undefined
                          ? { id: monthlyReservation.id, outcome: 'charge' }
                          : {
                              id: monthlyReservation.id,
                              outcome: 'charge',
                              costUsdMicros: (admissionOptions.estimatedCostUsdMicros ?? lunaCostUsdMicros)(
                                observedUsage,
                              ),
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
        if (admissionOptions.stateStore !== undefined) {
          const correlation =
            admissionOptions.correlationKey === undefined
              ? createHash('sha256')
                  .update(`${input.surface}:${snapshot.digest}:${engine.configurationIdentity}:${Date.now()}`)
                  .digest('hex')
              : correlateWithKey(
                  admissionOptions.correlationKey,
                  `${input.surface}:${snapshot.digest}:${engine.configurationIdentity}:${Date.now()}`,
                )
          yield* admissionOptions.stateStore.record({
            provenance: {
              correlation,
              atMillis: Date.now(),
              corpusDigest: snapshot.digest,
              engineConfiguration: engine.configurationIdentity,
              sourceCount: sources.length,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              estimatedCostUsdMicros: admissionOptions.estimatedCostUsdMicros?.(usage) ?? 0,
            },
            quota: {
              principal:
                admissionOptions.correlationKey === undefined
                  ? createHash('sha256')
                      .update(input.principalId ?? input.surface)
                      .digest('hex')
                  : correlateWithKey(admissionOptions.correlationKey, input.principalId ?? input.surface),
              atMillis: Date.now(),
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsdMicros: admissionOptions.estimatedCostUsdMicros?.(usage) ?? 0,
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

export const DocsWorkflowLive = makeDocsWorkflowLayer()

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
