import { Effect, Schema } from 'effect'

import { classifyIntentionalSource, evaluateAutomaticThread, type AutomaticThreadPolicyConfig } from './eligibility.ts'
import type { DiscordSnowflake, ThreadCandidate, ThreadClaimHandle, ThreadName, ThreadOutcome } from './model.ts'
import { resolveThreadName, type ThreadTitleConfig, type ThreadTitlePort } from './title.ts'

export class ThreadReconciliationError extends Schema.TaggedError<ThreadReconciliationError>()(
  'ThreadReconciliationError',
  { code: Schema.String, message: Schema.String },
) {}

export class ThreadMutationError extends Schema.TaggedError<ThreadMutationError>()('ThreadMutationError', {
  kind: Schema.Literals(['ambiguous', 'transient', 'terminal']),
  code: Schema.String,
  message: Schema.String,
}) {}

export type ReconciliationDecision =
  | Readonly<{ _tag: 'Proceed'; handle: ThreadClaimHandle }>
  | Readonly<{ _tag: 'AlreadySatisfied'; threadId: DiscordSnowflake }>
  | Readonly<{ _tag: 'Ambiguous' }>

export interface ThreadReconciliationPort {
  readonly prepare: (candidate: ThreadCandidate) => Effect.Effect<ReconciliationDecision, ThreadReconciliationError>
  readonly markCreating: (handle: ThreadClaimHandle) => Effect.Effect<void, ThreadReconciliationError>
  readonly markCreated: (
    handle: ThreadClaimHandle,
    threadId: DiscordSnowflake,
  ) => Effect.Effect<void, ThreadReconciliationError>
  readonly markUnknownExternal: (
    handle: ThreadClaimHandle,
    code: string,
  ) => Effect.Effect<void, ThreadReconciliationError>
  readonly markFailed: (handle: ThreadClaimHandle, code: string) => Effect.Effect<void, ThreadReconciliationError>
}

export interface ThreadMutationPort {
  readonly create: (input: {
    readonly guildId: DiscordSnowflake
    readonly channelId: DiscordSnowflake
    readonly messageId: DiscordSnowflake
    readonly name: ThreadName
  }) => Effect.Effect<DiscordSnowflake, ThreadMutationError>
}

export interface ThreadWorkflowPorts {
  readonly reconciliation: ThreadReconciliationPort
  readonly mutation: ThreadMutationPort
  readonly title: ThreadTitlePort
}

export interface ThreadWorkflowConfig {
  readonly policy: AutomaticThreadPolicyConfig
  readonly title: ThreadTitleConfig
}

/** One creation use case shared by Gateway, Discord interaction, and control RPC. */
export const makeThreadWorkflow = (ports: ThreadWorkflowPorts, config: ThreadWorkflowConfig) =>
  Effect.fn('threading.requestThread')(function* (candidate: ThreadCandidate): Effect.fn.Return<ThreadOutcome> {
    if (candidate.trigger._tag === 'Automatic') {
      const decision = evaluateAutomaticThread(candidate, config.policy)
      if (decision._tag === 'Rejected') {
        if (decision.reason === 'existing_thread' && candidate.existingThreadId !== undefined) {
          return { _tag: 'AlreadySatisfied', source: candidate.source, threadId: candidate.existingThreadId }
        }
        return { _tag: 'PolicyRejected', source: candidate.source, reason: decision.reason }
      }
    } else {
      if (candidate.trigger.authorized === false) return { _tag: 'AuthorizationRejected', source: candidate.source }
      const reason = classifyIntentionalSource(candidate, config.policy)
      if (reason === 'existing_thread' && candidate.existingThreadId !== undefined) {
        return { _tag: 'AlreadySatisfied', source: candidate.source, threadId: candidate.existingThreadId }
      }
      if (reason !== undefined) return { _tag: 'TerminalFailure', source: candidate.source, failureCode: reason }
    }

    const prepared = yield* Effect.result(ports.reconciliation.prepare(candidate))
    if (prepared._tag === 'Failure') {
      return { _tag: 'TransientFailure', source: candidate.source, failureCode: prepared.failure.code }
    }
    if (prepared.success._tag === 'AlreadySatisfied') {
      return { _tag: 'AlreadySatisfied', source: candidate.source, threadId: prepared.success.threadId }
    }
    if (prepared.success._tag === 'Ambiguous') {
      return { _tag: 'TransientFailure', source: candidate.source, failureCode: 'external_outcome_unknown' }
    }

    const claimHandle = prepared.success.handle
    if (claimHandle.sourceMessageId !== candidate.source.messageId) {
      return { _tag: 'TerminalFailure', source: candidate.source, failureCode: 'claim_source_mismatch' }
    }
    const name = yield* resolveThreadName(candidate, config.title, ports.title)
    const marked = yield* Effect.result(ports.reconciliation.markCreating(claimHandle))
    if (marked._tag === 'Failure') {
      return { _tag: 'TransientFailure', source: candidate.source, failureCode: marked.failure.code }
    }

    const created = yield* Effect.result(ports.mutation.create({ ...candidate.source, name }))
    if (created._tag === 'Failure') {
      const record =
        created.failure.kind === 'ambiguous'
          ? ports.reconciliation.markUnknownExternal(claimHandle, created.failure.code)
          : ports.reconciliation.markFailed(claimHandle, created.failure.code)
      yield* record.pipe(Effect.ignore)
      return created.failure.kind === 'terminal'
        ? { _tag: 'TerminalFailure', source: candidate.source, failureCode: created.failure.code }
        : { _tag: 'TransientFailure', source: candidate.source, failureCode: created.failure.code }
    }

    const recorded = yield* Effect.result(ports.reconciliation.markCreated(claimHandle, created.success))
    if (recorded._tag === 'Failure') {
      // Discord already confirmed the effect. A journal write failure is now an
      // ambiguous reconciliation condition, never permission to create again.
      return { _tag: 'TransientFailure', source: candidate.source, failureCode: recorded.failure.code }
    }
    return { _tag: 'Created', source: candidate.source, threadId: created.success }
  })
