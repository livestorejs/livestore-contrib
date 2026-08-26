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
    // Remote KV-backed state is the team/CI end state but requires the
    // token to hold Workers KV Storage Edit; until that permission exists,
    // stage locally on disk (.alchemy/, gitignored).
    ...(process.env['CF_STATE'] === 'remote'
      ? { state: Cloudflare.state() }
      : { state: Alchemy.localState() }),
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
