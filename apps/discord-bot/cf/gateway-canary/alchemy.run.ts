import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

import { canonicalStagingApplicationId } from '../src/release.ts'
import type { Coordinator } from './worker.ts'

export default Alchemy.Stack(
  'DiscordGatewayCanary',
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    if (stage !== 'staging') return yield* Effect.die('The Discord Gateway canary accepts only stage staging')

    const runUntil = yield* Config.string('DISCORD_GATEWAY_CANARY_RUN_UNTIL')
    const deadline = Date.parse(runUntil)
    if (Number.isFinite(deadline) === false || deadline - Date.now() > 60 * 60_000) {
      return yield* Effect.die('Set the canary run deadline to an ISO timestamp no more than one hour ahead')
    }

    const worker = yield* Cloudflare.Worker('GatewayCanary', {
      name: 'livestore-discord-gateway-canary-staging',
      main: new URL('./worker.ts', import.meta.url).href,
      crons: ['* * * * *'],
      compatibility: { date: '2026-07-04' },
      observability: { enabled: true },
      env: {
        COORDINATOR: Cloudflare.DurableObject<Coordinator>('Coordinator'),
        DISCORD_TOKEN: Config.redacted('DISCORD_GATEWAY_CANARY_STAGING_TOKEN'),
        RUN_UNTIL: runUntil,
        STAGING_APPLICATION_ID: canonicalStagingApplicationId,
      },
    })

    return { url: worker.url, durableObjects: worker.durableObjectNamespaces }
  }),
)
