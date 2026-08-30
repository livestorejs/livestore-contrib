/**
 * Application-command synchronization for the Cloudflare deployment.
 *
 * Reuses the portable desired-state declaration (`src/application-commands`)
 * verbatim so the edge deployment registers exactly the commands the Node host
 * would, and drives the dfx REST client over the Workers-native fetch HTTP
 * layer (prototype-proven transport, same approach as the gateway supervisor).
 *
 * Intended to run at deploy time (alchemy deploy hook) or on demand through an
 * admin RPC. Global command updates propagate to Discord clients within ~1h,
 * though usually much faster.
 */
import { Context, Effect, Layer, Redacted } from 'effect'
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from 'dfx'
import { FetchHttpClient } from 'effect/unstable/http'

import { diffApplicationCommands } from '../../src/application-commands/diff.ts'
import type { ApplicationCommandsDiff } from '../../src/application-commands/model.ts'
import { makeDfxApplicationCommandsPort } from '../../src/application-commands/dfx.ts'
import {
  type ApplicationCommand,
  type ApplicationCommandInventoryInvalid,
  type ApplicationCommandRemoteShapeUnsupported,
  type ApplicationCommandResidualDrift,
  type ApplicationCommandRestError,
  type ApplicationCommandScopeRejected,
} from '../../src/application-commands/model.ts'
import type { ApplicationCommandScope } from '../../src/application-commands/model.ts'
import { makeApplicationCommandsReconciler } from '../../src/application-commands/reconcile.ts'
/** Outcome of one synchronization pass, keyed by `${type}:${name}` identity. */
export interface SyncResult {
  readonly created: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
  readonly unchanged: number
}

export type SyncApplicationCommandsError =
  | ApplicationCommandRestError
  | ApplicationCommandRemoteShapeUnsupported
  | ApplicationCommandScopeRejected
  | ApplicationCommandInventoryInvalid
  | ApplicationCommandResidualDrift

/**
 * Pure projection of desired-vs-actual command state into per-identity change
 * buckets; exported so drift classification stays unit-testable without REST.
 */
export const computeCommandDiff = (
  desired: ReadonlyArray<ApplicationCommand>,
  actual: ReadonlyArray<ApplicationCommand>,
): SyncResult => syncResultFromDiff(diffApplicationCommands(desired, actual))

/**
 * Reconciles the global application-command inventory against the desired
 * declaration: list → diff → bulk replace → verify, refusing duplicates and
 * residual drift exactly like the Node host's reconciler.
 */
export const syncApplicationCommands = (input: {
  readonly token: string
  /** The RUNNING config's command scope (Node parity: commands.sync(config.commandScope)) —
   * staging deployments register guild-scoped, global fall back to GlobalCommandScope. */
  readonly scope: ApplicationCommandScope
}): Effect.Effect<SyncResult, SyncApplicationCommandsError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(restLayerFor(input.token))
      const rest = Context.get(context, DiscordREST)
      const reconciler = makeApplicationCommandsReconciler(makeDfxApplicationCommandsPort(rest))
      const outcome = yield* reconciler.sync(input.scope)
      return syncResultFromDiff(outcome.before)
    }).pipe(Effect.withSpan('discord.cf.syncApplicationCommands')),
  )

const restLayerFor = (token: string): Layer.Layer<DiscordREST> =>
  DiscordRESTMemoryLive.pipe(
    Layer.provide(DiscordConfig.layer({ token: Redacted.make(token) })),
    Layer.provide(FetchHttpClient.layer),
  )

const syncResultFromDiff = (diff: ApplicationCommandsDiff): SyncResult => {
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
