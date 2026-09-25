/**
 * Alchemy v2 stack — the single IaC source of truth for the Discord bot.
 * No wrangler.jsonc: everything below is declared here.
 */
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Output from 'alchemy/Output'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { canonicalStagingIdentity, deploymentIdentityMismatch } from './src/release.ts'
import { DiscordBot } from './src/worker.ts'

export default Alchemy.Stack(
  'DiscordBot',
  {
    providers: Cloudflare.providers(),
    // Shared remote state is mandatory for every remote stage. The only
    // filesystem-state stack is the explicitly local alchemy.local.ts entry.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    if (process.env['ALCHEMY_LOCAL'] === '1') {
      return yield* Effect.die('remote stack refuses ALCHEMY_LOCAL=1; use alchemy.local.ts')
    }
    const deploymentIdentity = yield* Config.all({
      releaseId: Config.schema(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)), 'RELEASE_ID'),
      workerName: Config.schema(Schema.Trimmed.check(Schema.isNonEmpty()), 'CF_WORKER_NAME'),
      botStateNamespaceId: Config.schema(
        Schema.Trimmed.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
        'CF_BOT_STATE_NAMESPACE_ID',
      ),
    })
    const stage = yield* Alchemy.Stage
    if (stage !== 'staging') {
      return yield* Effect.die(
        `remote stage ${stage} is not admitted; production remains gated and local work uses alchemy.local.ts`,
      )
    }
    const requestedIdentityMismatch = deploymentIdentityMismatch(canonicalStagingIdentity, deploymentIdentity)
    if (requestedIdentityMismatch !== undefined) {
      return yield* Effect.die(requestedIdentityMismatch)
    }
    if (process.env['CF_WORKER_NAME']?.trim() !== canonicalStagingIdentity.workerName) {
      return yield* Effect.die(
        'CF_WORKER_NAME must be exported in the invoking environment so the Worker name is pinned before resource evaluation',
      )
    }
    const worker = yield* DiscordBot
    const botStateNamespace = worker.durableObjectNamespaces['BotState']
    if (botStateNamespace === undefined) {
      return yield* Effect.die('remote Worker has no BotState Durable Object namespace')
    }
    // Resource outputs are not available while the stack is being declared.
    // Resolve and compare them only after reconciliation, when Alchemy evaluates
    // the stack output against the Worker's actual attributes.
    const verifiedReleaseId = Output.mapEffect(([workerName, botStateNamespaceId]) => {
      const identityMismatch = deploymentIdentityMismatch(deploymentIdentity, {
        workerName,
        botStateNamespaceId,
      })
      return identityMismatch === undefined
        ? Effect.succeed(deploymentIdentity.releaseId)
        : Effect.die(identityMismatch)
    })(Output.all(worker.workerName, botStateNamespace))
    return {
      url: worker.url,
      crons: worker.crons,
      durableObjects: worker.durableObjectNamespaces,
      releaseId: verifiedReleaseId,
    }
  }),
)
