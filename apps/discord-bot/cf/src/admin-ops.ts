import { Effect, Schema } from 'effect'

import { DeploymentEnvironment, DiscordMessageRef, DiscordSnowflake, OperatorReason } from '../../src/control/schema.ts'
import {
  candidateForOperator,
  type OperatorSourceFacts,
  type OperatorSourceReader,
  type OperatorSourceReadError,
} from '../../src/runtime/threading-adapter.ts'
import type { ThreadObservationPort } from '../../src/reconciliation/port.ts'
import type { ThreadCandidate, ThreadOutcome } from '../../src/threading/model.ts'
import { EnvironmentName } from '../../src/threading/model.ts'
import {
  encodeConfigSummary,
  RuntimeConfigPutPayload,
  RuntimeConfigRevisionConflict,
  type RuntimeConfigDocument,
  type RuntimeConfigStore,
} from './runtime-config.ts'

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
      _tag: unrun > 0 ? 'Unrun' : applied === true ? 'Success' : 'Planned',
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

export interface CommandsSyncResult {
  readonly created: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
  readonly unchanged: number
}

export const commandsSyncResultFromDiff = (diff: {
  readonly changes: ReadonlyArray<{ readonly kind: 'unchanged' | 'create' | 'update' | 'delete'; readonly key: string }>
}): CommandsSyncResult => {
  const created: Array<string> = []
  const updated: Array<string> = []
  const deleted: Array<string> = []
  let unchanged = 0
  for (const change of diff.changes) {
    if (change.kind === 'unchanged') unchanged += 1
    else if (change.kind === 'create') created.push(change.key)
    else if (change.kind === 'update') updated.push(change.key)
    else deleted.push(change.key)
  }
  return { created, updated, deleted, unchanged }
}

/** SyncResult projection in the CLI's commandDiffResult shape. */
export const commandsSyncOutcome = (
  result: CommandsSyncResult,
  mode: 'plan' | 'apply' = 'apply',
): AdminOperationOutcome => {
  const changed = result.created.length + result.updated.length + result.deleted.length > 0
  const counts = `create=${result.created.length} update=${result.updated.length} delete=${result.deleted.length} unchanged=${result.unchanged}`
  return successOutcome(
    `changes=${changed === true ? 'true' : 'false'} ${counts}`,
    mode === 'plan' ? 'Planned' : changed === true ? 'Success' : 'AlreadySatisfied',
  )
}

export interface RuntimeConfigAdminOperations<TCandidate> {
  readonly configGet: Effect.Effect<AdminOperationOutcome>
  readonly configPut: (payload: unknown) => Effect.Effect<AdminOperationOutcome>
}

/**
 * Storage-first config control. Neither operation needs a running runtime:
 * GET can diagnose a failed boot, while PUT can repair it. Reload builds the
 * complete candidate before the durable CAS and runtime swap, so a bad token
 * identity or other build failure preserves both the stored and running config.
 */
export const makeRuntimeConfigAdminOperations = <TCandidate>(deps: {
  readonly store: RuntimeConfigStore
  readonly getRunning: () => RuntimeConfigDocument | undefined
  readonly buildCandidate: (document: RuntimeConfigDocument) => Effect.Effect<TCandidate, unknown>
  readonly activateCandidate: (candidate: TCandidate) => Effect.Effect<void>
}): RuntimeConfigAdminOperations<TCandidate> => {
  const storeUnavailable = (): AdminOperationOutcome =>
    dependencyUnavailable('runtime-config-store', 'Runtime config store is unavailable')

  const configGet = Effect.map(deps.store.read, (stored): AdminOperationOutcome => {
    const running = deps.getRunning()
    const diverged = running === undefined || running.revision !== stored.revision
    return {
      ok: true,
      status: 200,
      body: {
        _tag: 'Success',
        summary: `storedRevision=${stored.revision} runningRevision=${running?.revision ?? 'unavailable'} diverged=${diverged}`,
        stored: {
          revision: stored.revision,
          summary: encodeConfigSummary(stored.config),
          config: stored.config,
        },
        running:
          running === undefined
            ? null
            : {
                revision: running.revision,
                summary: encodeConfigSummary(running.config),
              },
        diverged,
      },
    }
  }).pipe(
    Effect.catch(() => Effect.succeed(storeUnavailable())),
  )

  const configPut = (raw: unknown): Effect.Effect<AdminOperationOutcome> =>
    Effect.flatMap(
      Schema.decodeUnknownEffect(RuntimeConfigPutPayload, { onExcessProperty: 'error' })(raw),
      (payload) =>
        Effect.gen(function* () {
          const current = yield* deps.store.read
          if (current.revision !== payload.expectedRevision) {
            return failureOutcome(
              {
                _tag: 'InvalidControlInput',
                message: `Stale runtime config revision: expected ${payload.expectedRevision}, current ${current.revision}`,
              },
              409,
            )
          }

          const candidateDocument: RuntimeConfigDocument = {
            revision: current.revision + 1,
            // releaseId is deploy-owned, never writable through the admin plane.
            config: { ...payload.config, releaseId: current.config.releaseId },
          }

          if (payload.reload === false) {
            const stored = yield* deps.store.write({
              expectedRevision: payload.expectedRevision,
              config: candidateDocument.config,
            })
            return {
              ok: true,
              status: 200,
              body: {
                _tag: 'Planned',
                summary: `Runtime config persisted at revision ${stored.revision}; reload not requested.`,
                revision: stored.revision,
                applied: false,
              },
            }
          }

          const candidateExit = yield* Effect.exit(deps.buildCandidate(candidateDocument))
          if (candidateExit._tag === 'Failure') {
            return applicationFailure(
              `Runtime config candidate could not be built; revision ${current.revision} remains stored and running`,
            )
          }

          const stored = yield* deps.store.write({
            expectedRevision: payload.expectedRevision,
            config: candidateDocument.config,
          })
          const activationExit = yield* Effect.exit(deps.activateCandidate(candidateExit.value))
          if (activationExit._tag === 'Failure') {
            const runningRevision = deps.getRunning()?.revision
            return {
              ok: false,
              status: 502,
              body: {
                _tag: 'ControlAmbiguousOutcome',
                message:
                  `Runtime config persisted at revision ${stored.revision} but activation failed; the prior runtime remains installed`,
                state: 'persisted-but-not-activated',
                storedRevision: stored.revision,
                runningRevision: runningRevision ?? null,
                diverged: runningRevision !== stored.revision,
              },
            }
          }
          return {
            ok: true,
            status: 200,
            body: {
              _tag: 'Success',
              summary: `Runtime config revision ${stored.revision} persisted and reloaded.`,
              revision: stored.revision,
              applied: true,
            },
          }
        }).pipe(
          Effect.catch((error) =>
            error instanceof RuntimeConfigRevisionConflict
              ? Effect.succeed(
                  failureOutcome(
                    {
                      _tag: 'InvalidControlInput',
                      message: `Stale runtime config revision: expected ${error.expectedRevision}, current ${error.actualRevision}`,
                    },
                    409,
                  ),
                )
              : Effect.succeed(storeUnavailable())),
        ),
    ).pipe(
      Effect.catch(() =>
        Effect.succeed(
          failureOutcome(
            { _tag: 'InvalidControlInput', message: 'Runtime config request failed schema validation' },
            422,
          ),
        )),
    )

  return { configGet, configPut }
}

export const CommandsSyncPayload = Schema.Struct({
  environment: DeploymentEnvironment,
  reason: OperatorReason,
  apply: Schema.Boolean,
  expectedApplicationId: DiscordSnowflake,
  expectedGuildId: DiscordSnowflake,
}).annotate({ identifier: 'DiscordBot.CommandsSyncPayload' })

/**
 * Guarded command reconciliation. Plans use the running scope but cannot
 * mutate REST state. Applies additionally require durable/running config
 * convergence immediately before the synchronizer is invoked.
 */
export const makeCommandsSyncOperation = (deps: {
  readonly running: RuntimeConfigDocument
  readonly readStored: Effect.Effect<RuntimeConfigDocument, unknown>
  readonly plan: (scope: RuntimeConfigDocument['config']['commandScope']) => Effect.Effect<CommandsSyncResult, unknown>
  readonly apply: (scope: RuntimeConfigDocument['config']['commandScope']) => Effect.Effect<CommandsSyncResult, unknown>
}) => (raw: unknown): Effect.Effect<AdminOperationOutcome> =>
  Effect.flatMap(
    Schema.decodeUnknownEffect(CommandsSyncPayload, { onExcessProperty: 'error' })(raw),
    (payload) => {
      const config = deps.running.config
      // Logs stay on the OPS-R10 allowlist: no Discord identifiers or
      // operator-supplied reason/content. The authenticated response below
      // echoes only reason/environment/apply, never the raw ID fingerprint.
      const audit = Effect.logInfo('Application-command sync requested').pipe(
        Effect.annotateLogs({
          environment: payload.environment,
          apply: payload.apply,
        }),
      )
      const record = (
        operation: Effect.Effect<AdminOperationOutcome, unknown>,
      ): Effect.Effect<AdminOperationOutcome, unknown> =>
        Effect.andThen(audit, operation).pipe(
          Effect.map((outcome) => ({
            ...outcome,
            body: {
              ...outcome.body,
              commandSync: {
                environment: payload.environment,
                reason: payload.reason,
                apply: payload.apply,
              },
            },
          })),
        )
      if (
        payload.environment !== config.environment ||
        payload.expectedApplicationId !== config.applicationId ||
        payload.expectedGuildId !== config.guildId
      ) {
        return record(
          Effect.succeed(
            failureOutcome(
              {
                _tag: 'InvalidControlInput',
                message: 'Command sync fingerprint does not match the current running config',
              },
              409,
            ),
          ),
        )
      }

      if (payload.apply === false) {
        return record(
          deps.plan(config.commandScope).pipe(
            Effect.map((result) => commandsSyncOutcome(result, 'plan')),
            Effect.catch(() =>
              Effect.succeed(dependencyUnavailable('discord-application-commands', 'Command sync plan failed'))),
          ),
        )
      }

      return record(
        Effect.flatMap(deps.readStored, (stored) =>
          stored.revision !== deps.running.revision
            ? Effect.succeed(
                failureOutcome(
                  {
                    _tag: 'InvalidControlInput',
                    message: `Stored config revision ${stored.revision} diverges from running revision ${deps.running.revision}`,
                  },
                  409,
                ),
              )
            : deps.apply(config.commandScope).pipe(
                Effect.map((result) => commandsSyncOutcome(result, 'apply')),
                Effect.catch(() =>
                  Effect.succeed(
                    dependencyUnavailable('discord-application-commands', 'Application-command sync failed'),
                  )),
              )),
      )
    },
  ).pipe(
    Effect.catch(() =>
      Effect.succeed(
        failureOutcome(
          { _tag: 'InvalidControlInput', message: 'Command sync request failed schema validation' },
          422,
        ),
      )),
  )
