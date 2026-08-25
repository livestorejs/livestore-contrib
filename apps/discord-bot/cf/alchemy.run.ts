/**
 * Alchemy v2 stack — the single IaC source of truth for the Discord bot.
 * No wrangler.jsonc: everything below is declared here.
 */
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'

import { DiscordBot } from './src/worker.ts'

export default Alchemy.Stack(
  'DiscordBot',
  {
    providers: Cloudflare.providers(),
    // Cloudflare-hosted remote state store (team/CI default).
    // For credential-free local experiments swap in:
    //   state: localState()          // from "alchemy" — .alchemy/ on disk
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* DiscordBot
    return {
      url: worker.url,
      crons: worker.crons,
      durableObjects: worker.durableObjectNamespaces,
    }
  }),
)
