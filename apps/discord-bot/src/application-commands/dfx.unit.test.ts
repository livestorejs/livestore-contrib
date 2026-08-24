import { describe, it } from "@effect/vitest"
import { Discord } from "dfx"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import {
  desiredApplicationCommands,
  makeDfxApplicationCommandsPort,
  RetiredHistoricalApplicationId,
  type ApplicationCommandsRest,
  type GlobalCommandScope,
  type GuildCommandScope,
} from "./index.ts"
import { DiscordSnowflake } from "../threading/model.ts"

const applicationId = Schema.decodeSync(DiscordSnowflake)("200000000000000001")
const guildId = Schema.decodeSync(DiscordSnowflake)("300000000000000001")
const guildScope: GuildCommandScope = { _tag: "GuildCommandScope", applicationId, guildId }
const globalScope: GlobalCommandScope = { _tag: "GlobalCommandScope", applicationId }

describe("DFX application command port", () => {
  it.effect("uses only the configured guild route for staging-style scope", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const requests: Array<Discord.ApplicationCommandCreateRequest> = []
      const port = makeDfxApplicationCommandsPort(fakeRest(calls, requests))
      yield* port.list(guildScope)
      yield* port.replace(guildScope, desiredApplicationCommands)
      expect(calls).toEqual([
        `list-guild:${applicationId}:${guildId}`,
        `replace-guild:${applicationId}:${guildId}`,
      ])
      expect(requests.every(request => request.contexts === undefined)).toBe(true)
      expect(requests.every(request => request.integration_types === undefined)).toBe(true)
    }),
  )

  it.effect("makes global guild-only visibility explicit", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const requests: Array<Discord.ApplicationCommandCreateRequest> = []
      const port = makeDfxApplicationCommandsPort(fakeRest(calls, requests))
      const replaced = yield* port.replace(globalScope, desiredApplicationCommands)
      expect(calls).toEqual([`replace-global:${applicationId}`])
      expect(requests.every(request =>
        request.contexts?.[0] === Discord.InteractionContextType.GUILD &&
        request.integration_types?.[0] === Discord.ApplicationIntegrationType.GUILD_INSTALL
      )).toBe(true)
      expect(replaced.every(command => command.contexts?.[0] === 0 && command.integrationTypes?.[0] === 0))
        .toBe(true)
    }),
  )

  it.effect("fences the retired historical application before any REST call", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const port = makeDfxApplicationCommandsPort(fakeRest(calls, []))
      const retired: GlobalCommandScope = {
        _tag: "GlobalCommandScope",
        applicationId: Schema.decodeSync(DiscordSnowflake)(RetiredHistoricalApplicationId),
      }
      const listError = yield* port.list(retired).pipe(Effect.flip)
      const replaceError = yield* port.replace(retired, desiredApplicationCommands).pipe(Effect.flip)
      expect(listError._tag).toBe("ApplicationCommandScopeRejected")
      expect(replaceError._tag).toBe("ApplicationCommandScopeRejected")
      expect(calls).toEqual([])
    }),
  )

  it.effect("rejects an unsupported remote option shape instead of dropping it", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const rest = fakeRest(calls, [])
      const unsupportedResponse: Discord.ApplicationCommandResponse = {
        ...response(desiredApplicationCommands[0], applicationId, 0),
        options: [{
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "private",
          description: "Whether the answer should be private",
        }],
      }
      const port = makeDfxApplicationCommandsPort({
        ...rest,
        listApplicationCommands: () => Effect.succeed([unsupportedResponse]),
      })
      const error = yield* port.list(globalScope).pipe(Effect.flip)
      expect(error._tag).toBe("ApplicationCommandRemoteShapeUnsupported")
      if (error._tag === "ApplicationCommandRemoteShapeUnsupported") {
        expect(error.commandKey).toBe("1:docs")
      }
    }),
  )
})

const fakeRest = (
  calls: Array<string>,
  capturedRequests: Array<Discord.ApplicationCommandCreateRequest>,
): ApplicationCommandsRest => ({
  listApplicationCommands: appId => Effect.sync(() => {
    calls.push(`list-global:${appId}`)
    return desiredApplicationCommands.map((command, index) => response(command, appId, index))
  }),
  bulkSetApplicationCommands: (appId, requests) => Effect.sync(() => {
    calls.push(`replace-global:${appId}`)
    capturedRequests.push(...requests)
    return requests.map((request, index) => responseFromRequest(request, appId, index))
  }),
  listGuildApplicationCommands: (appId, targetGuildId) => Effect.sync(() => {
    calls.push(`list-guild:${appId}:${targetGuildId}`)
    return desiredApplicationCommands.map((command, index) => ({
      ...response(command, appId, index),
      guild_id: targetGuildId,
    }))
  }),
  bulkSetGuildApplicationCommands: (appId, targetGuildId, requests) => Effect.sync(() => {
    calls.push(`replace-guild:${appId}:${targetGuildId}`)
    capturedRequests.push(...requests)
    return requests.map((request, index) => ({
      ...responseFromRequest(request, appId, index),
      guild_id: targetGuildId,
    }))
  }),
})

const response = (
  command: (typeof desiredApplicationCommands)[number],
  appId: string,
  index: number,
): Discord.ApplicationCommandResponse => ({
  id: `40000000000000000${index}`,
  application_id: appId,
  version: `50000000000000000${index}`,
  type: command.type,
  name: command.name,
  description: command.description,
  options: command.options,
  default_member_permissions: command.defaultMemberPermissions,
  nsfw: command.nsfw,
})

const responseFromRequest = (
  request: Discord.ApplicationCommandCreateRequest,
  appId: string,
  index: number,
): Discord.ApplicationCommandResponse => ({
  id: `40000000000000000${index}`,
  application_id: appId,
  version: `50000000000000000${index}`,
  type: request.type ?? Discord.ApplicationCommandType.CHAT,
  name: request.name,
  description: request.description ?? "",
  options: (request.options ?? []).flatMap(option =>
    option.type === Discord.ApplicationCommandOptionType.STRING
      ? [{
          type: Discord.ApplicationCommandOptionType.STRING,
          name: option.name,
          description: option.description,
          required: option.required === true,
          autocomplete: option.autocomplete ?? undefined,
          choices: option.choices ?? undefined,
          min_length: option.min_length ?? undefined,
          max_length: option.max_length ?? undefined,
        }]
      : [],
  ),
  default_member_permissions: request.default_member_permissions === undefined
    ? null
    : request.default_member_permissions === null
      ? null
      : String(request.default_member_permissions),
  nsfw: false,
  contexts: request.contexts ?? undefined,
  integration_types: request.integration_types ?? undefined,
})
