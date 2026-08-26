import { Effect, Schema } from 'effect'

import { DeploymentEnvironment, DiscordMessageRef, OperatorReason } from '../../src/control/schema.ts'
import {
  candidateForOperator,
  type OperatorSourceFacts,
  type OperatorSourceReader,
  type OperatorSourceReadError,
} from '../../src/runtime/threading-adapter.ts'
import type { ThreadObservationPort } from '../../src/reconciliation/port.ts'
import type { ThreadCandidate, ThreadOutcome } from '../../src/threading/model.ts'
import { EnvironmentName } from '../../src/threading/model.ts'

/**
 * Admin-plane operation bodies for the Cloudflare host: the same semantics as
 * the Node control plane's `ThreadCreate` (environment/scope admission →
 * source read → authoritative thread observation → journal-claimed thread
 * workflow), reduced to plain JSON outcomes. Everything crosses the Durable
 * Object RPC stub and the HTTP boundary, so results are deliberately
 * class-free: `{ ok, status, body }` with `body` shaped like the encoded
 * `ControlResult` / `ControlError` tags the CLI already parses.
 */
export interface AdminOperationOutcome {
  readonly ok: boolean
  readonly status: number
  readonly body: Record<string, unknown>
}

const successOutcome = (summary: string, tag: string, correlationId?: string): AdminOperationOutcome => ({
  ok: true,
  status: 200,
  body: {
    _tag: tag,
    summary,
    ...(correlationId === undefined ? {} : { correlationId }),
  },
})

const failureOutcome = (
  error: Record<string, unknown>,
  status: number,
): AdminOperationOutcome => ({ ok: false, status, body: error })

/**
 * Ports the Node control plane's thread-outcome → ControlResult mapping
 * (Created/AlreadySatisfied succeed with the thread id; rejections fail;
 * transient failures stay ambiguous because Discord may have committed).
 */
export const controlResultFromThreadOutcome = (outcome: ThreadOutcome): AdminOperationOutcome => {
  switch (outcome._tag) {
    case 'Created':
      return successOutcome(`Created thread ${outcome.threadId}.`, 'Success', outcome.source.messageId)
    case 'AlreadySatisfied':
      return successOutcome(
        `Thread ${outcome.threadId} already satisfies the request.`,
        'AlreadySatisfied',
        outcome.source.messageId,
      )
    case 'AuthorizationRejected':
      return failureOutcome({ _tag: 'ControlApplicationFailure', message: 'Thread request was not authorized' }, 409)
    case 'PolicyRejected':
      return failureOutcome(
        { _tag: 'ControlApplicationFailure', message: `Thread request rejected by policy: ${outcome.reason}` },
        409,
      )
    case 'TerminalFailure':
      return failureOutcome(
        { _tag: 'ControlApplicationFailure', message: `Thread creation failed: ${outcome.failureCode}` },
        409,
      )
    case 'TransientFailure':
      return failureOutcome(
        {
          _tag: 'ControlAmbiguousOutcome',
          message: `Thread outcome requires reconciliation: ${outcome.failureCode}`,
          correlationId: outcome.source.messageId,
        },
        502,
      )
  }
}

export interface OperatorThreadCreateInput {
  readonly source: typeof DiscordMessageRef.Type
  readonly environment: string
  readonly apply: true
  readonly reason: string
  /** Optional operator-requested title (CLI --name); validated downstream. */
  readonly name?: string | undefined
}

/** Payload schema shared with the admin router; the CLI encodes the same shape. */
/** Single shared ThreadCreate payload schema — the admin router AND the DO
 * operation validate against this exact shape, which mirrors the CLI encoder
 * including the optional requested title. */
export const OperatorThreadCreatePayload = Schema.Struct({
  source: DiscordMessageRef,
  environment: DeploymentEnvironment,
  apply: Schema.Literal(true),
  reason: OperatorReason,
  name: Schema.optional(Schema.String),
})

export interface OperatorThreadCreateDeps {
  /** The running bot's config; admission compares against it exactly like Node. */
  readonly config: {
    readonly environment: string
    readonly guildId: string
    readonly actionChannelIds: ReadonlyArray<string>
  }
  /** Principal of the HTTPS bearer caller — the admin token is the write authority here. */
  readonly principal?: string | undefined
  readonly sourceReader: OperatorSourceReader
  readonly sourceObserver: ThreadObservationPort
  readonly thread: (candidate: ThreadCandidate) => Effect.Effect<ThreadOutcome>
}

const dependencyUnavailable = (dependency: string, message: string): AdminOperationOutcome =>
  failureOutcome({ _tag: 'ControlDependencyUnavailable', dependency, message }, 503)

const applicationFailure = (message: string): AdminOperationOutcome =>
  failureOutcome({ _tag: 'ControlApplicationFailure', message }, 409)

const factsFromReadError = (error: OperatorSourceReadError): AdminOperationOutcome =>
  error.kind === 'unavailable'
    ? dependencyUnavailable('discord-source-read', error.message)
    : applicationFailure(error.message)

/**
 * Runs the REAL operator trigger through the thread workflow: journal claim →
 * Discord API create → outcome, mirroring the Node control plane's `create`.
 */
export const makeOperatorThreadCreate = (deps: OperatorThreadCreateDeps) => {
  const readFacts = (source: OperatorThreadCreateInput['source']): Effect.Effect<OperatorSourceFacts, AdminOperationOutcome> =>
    deps.sourceReader.read(source).pipe(
      Effect.mapError(factsFromReadError),
      Effect.flatMap((facts) =>
        deps.sourceObserver.observeSourceThread({
          sourceMessageId: source.messageId,
          channelId: source.channelId,
        }).pipe(
          Effect.mapError(() =>
            dependencyUnavailable(
              'discord-thread-observation',
              'Existing source thread could not be authoritatively checked',
            )
          ),
          Effect.flatMap((observation) => {
            if (observation._tag === 'Unrun') {
              return Effect.fail(
                dependencyUnavailable(
                  'discord-thread-observation',
                  'Existing source thread could not be authoritatively checked',
                ),
              )
            }
            return Effect.succeed(
              observation._tag === 'ExactSourceThread'
                ? { ...facts, existingThreadId: observation.threadId }
                : facts,
            )
          }),
        ),
      ),
    )

  return (input: OperatorThreadCreateInput): Effect.Effect<AdminOperationOutcome> => {
    if (input.environment !== deps.config.environment) {
      return Effect.succeed(applicationFailure('Requested environment does not match the running bot'))
    }
    if (
      input.source.guildId !== deps.config.guildId ||
      deps.config.actionChannelIds.includes(input.source.channelId) === false
    ) {
      return Effect.succeed(
        applicationFailure('Requested source is outside the configured guild/channel scope'),
      )
    }
    // Every failure in this pipeline is already an encoded outcome body, so
    // the error channel folds back into the success channel here — the admin
    // route always answers with a decodable HTTP response.
    return readFacts(input.source).pipe(
      Effect.flatMap((facts) =>
        deps.thread(
          candidateForOperator(
            input.source,
            Schema.decodeUnknownSync(EnvironmentName)(deps.config.environment),
            input.name,
            input.reason,
            deps.principal ?? 'admin',
            true,
            facts,
          ),
        ),
      ),
      Effect.map(controlResultFromThreadOutcome),
      Effect.catchIf(
        (error): error is AdminOperationOutcome => true,
        (error) => Effect.succeed(error),
      ),
    )
  }
}

/** ThreadReconcile payload mirroring the Node control plane's schema exactly. */
export const ThreadReconcilePayload = Schema.Struct({
  source: Schema.optional(DiscordMessageRef),
  all: Schema.Boolean,
  state: Schema.optional(Schema.Literals(['creating', 'unknown_external'])),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  apply: Schema.Boolean,
  environment: Schema.optional(DeploymentEnvironment),
  reason: Schema.optional(OperatorReason),
})

export interface ReconcileOutcomeInput {
  readonly receipts: ReadonlyArray<{
    readonly receiptId: string
    readonly disposition: string
    readonly mutated: boolean
  }>
  readonly truncated: boolean
}

/** Ports the Node control plane's renderReconciliationResult projection. */
export const reconcileOutcome = (applied: boolean, result: ReconcileOutcomeInput): AdminOperationOutcome => {
  const unrun = result.receipts.filter((r) => r.disposition === 'unrun').length
  const mutated = result.receipts.filter((r) => r.mutated).length
  return {
    ok: true,
    status: 200,
    body: {
      _tag: unrun > 0 ? 'Unrun' : applied ? 'Success' : 'Planned',
      summary: `receipts=${result.receipts.length} mutated=${mutated} unrun=${unrun} truncated=${result.truncated}`,
      ...(result.receipts.length === 1 ? { receiptId: result.receipts[0]?.receiptId } : {}),
    },
  }
}

/** Portable synchronous receipt digest (FNV-1a x2, hex) for the worker host.
 * Receipt ids are per-run correlation labels; only node's ids are sha256. */
export const portableReceiptDigestHex = (material: string): string => {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < material.length; i++) {
    const code = material.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ ((code + i) & 0xff), 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(3)
}

/** SyncResult projection in the CLI's commandDiffResult shape. */
export const commandsSyncOutcome = (result: {
  readonly created: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
  readonly unchanged: number
}): AdminOperationOutcome => {
  const changed =
    result.created.length + result.updated.length + result.deleted.length > 0
  const counts = `create=${result.created.length} update=${result.updated.length} delete=${result.deleted.length} unchanged=${result.unchanged}`
  return successOutcome(`changes=${changed ? 'true' : 'false'} ${counts}`, changed ? 'Success' : 'AlreadySatisfied')
}
