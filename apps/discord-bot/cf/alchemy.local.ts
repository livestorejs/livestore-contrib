/**
 * Credential-free variant for local validation: identical resources, but
 * filesystem state (alchemy.local state store) and no custom domain. The
 * remote stack in alchemy.run.ts remains the deployment source of truth.
 */
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'

process.env['ALCHEMY_LOCAL'] = '1'

export default Alchemy.Stack(
  'DiscordBotLocal',
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { DiscordBot } = yield* Effect.promise(() => import('./src/worker.ts'))
    const worker = yield* DiscordBot
    return { url: worker.url }
  }),
)
