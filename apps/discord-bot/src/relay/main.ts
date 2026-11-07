import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Effect } from 'effect'
import { layerWebSocketConstructorGlobal } from 'effect/unstable/socket/Socket'

import { acquireActionAuthority } from '../runtime/authority-lock.ts'
import { openRelayOutbox } from './outbox.ts'
import { runGatewayRelay } from './relay.ts'

const snowflake = /^\d{17,20}$/

export const runConfiguredRelay = (env: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const stateDirectory = env['LIVESTORE_DISCORD_RELAY_STATE']
    const origin = env['LIVESTORE_DISCORD_RELAY_ORIGIN']
    const guildId = env['LIVESTORE_DISCORD_RELAY_GUILD']
    const applicationId = env['LIVESTORE_DISCORD_RELAY_APPLICATION']
    const channels = new Set(env['LIVESTORE_DISCORD_RELAY_CHANNELS']?.split(','))
    const credentials = env['CREDENTIALS_DIRECTORY']
    if (
      stateDirectory === undefined ||
      origin === undefined ||
      guildId === undefined ||
      snowflake.test(guildId) === false ||
      applicationId === undefined ||
      snowflake.test(applicationId) === false ||
      channels.size === 0 ||
      [...channels].some((id) => snowflake.test(id) === false) === true ||
      credentials === undefined
    ) {
      return yield* Effect.die(new Error('Incomplete Discord relay configuration'))
    }

    const endpoint = new URL(origin)
    if (endpoint.origin !== origin || endpoint.protocol !== 'https:') {
      return yield* Effect.die(new Error('Discord relay requires an HTTPS origin'))
    }
    const readCredential = (name: string) =>
      Effect.promise(async () => (await readFile(join(credentials, name), 'utf8')).trim())
    const botToken = yield* readCredential('discord-bot-token')
    const token = yield* readCredential('gateway-relay-token')
    if (botToken === '' || token === '' || botToken === token) {
      return yield* Effect.die(new Error('Discord relay requires distinct nonempty credentials'))
    }

    yield* acquireActionAuthority(stateDirectory)
    const identity = yield* Effect.promise(async (signal) => {
      const response = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
        headers: { authorization: `Bot ${botToken}`, 'user-agent': 'LiveStore-Discord-Relay' },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      if (response.ok === false) return undefined
      return (await response.json()) as { readonly id?: string }
    })
    if (identity?.id !== applicationId) {
      return yield* Effect.die(new Error('Discord relay token does not match the configured application'))
    }

    const outbox = yield* Effect.acquireRelease(
      Effect.sync(() => openRelayOutbox(join(stateDirectory, 'gateway-relay.sqlite'), 10_000)),
      (open) => Effect.sync(() => open.close()),
    )
    return yield* runGatewayRelay({ botToken, guildId, channels, endpoint, token, outbox })
  }).pipe(Effect.scoped, Effect.provide(layerWebSocketConstructorGlobal))
