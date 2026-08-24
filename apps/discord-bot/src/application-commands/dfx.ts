import { Discord } from "dfx"
import type { DiscordRestService } from "dfx/DiscordREST"
import * as Effect from "effect/Effect"
import type { ApplicationCommand, ApplicationCommandScope } from "./model.ts"
import {
  ApplicationCommandRemoteShapeUnsupported,
  ApplicationCommandRestError,
  assertAllowedApplicationId,
} from "./model.ts"
import type { ApplicationCommandsPort } from "./port.ts"
import { toDiscordCommandRequest } from "./desired.ts"

export interface ApplicationCommandsRest {
  readonly listApplicationCommands: DiscordRestService["listApplicationCommands"]
  readonly bulkSetApplicationCommands: DiscordRestService["bulkSetApplicationCommands"]
  readonly listGuildApplicationCommands: DiscordRestService["listGuildApplicationCommands"]
  readonly bulkSetGuildApplicationCommands: DiscordRestService["bulkSetGuildApplicationCommands"]
}

/** Narrow, scope-explicit adapter over DFX's generated and rate-limited REST client. */
export const makeDfxApplicationCommandsPort = (
  rest: ApplicationCommandsRest,
): ApplicationCommandsPort => ({
  list: scope => {
    const rejected = assertAllowedApplicationId(scope.applicationId)
    if (rejected !== undefined) return Effect.fail(rejected)
    return list(rest, scope).pipe(
      mapRestError("list", scope),
      Effect.flatMap(commands => Effect.forEach(commands, fromDiscordCommand)),
      Effect.withSpan("discord.applicationCommands.rest.list"),
    )
  },
  replace: (scope, commands) => {
    const rejected = assertAllowedApplicationId(scope.applicationId)
    if (rejected !== undefined) return Effect.fail(rejected)
    const requests = commands.map(command => toDiscordCommandRequest(command, scope))
    return replace(rest, scope, requests).pipe(
      mapRestError("replace", scope),
      Effect.flatMap(result => Effect.forEach(result, fromDiscordCommand)),
      Effect.withSpan("discord.applicationCommands.rest.replace"),
    )
  },
})

const list = (rest: ApplicationCommandsRest, scope: ApplicationCommandScope) =>
  scope._tag === "GuildCommandScope"
    ? rest.listGuildApplicationCommands(scope.applicationId, scope.guildId)
    : rest.listApplicationCommands(scope.applicationId)

const replace = (
  rest: ApplicationCommandsRest,
  scope: ApplicationCommandScope,
  commands: ReadonlyArray<Discord.ApplicationCommandCreateRequest>,
) => scope._tag === "GuildCommandScope"
  ? rest.bulkSetGuildApplicationCommands(scope.applicationId, scope.guildId, commands)
  : rest.bulkSetApplicationCommands(scope.applicationId, commands)

const fromDiscordCommand = (
  command: Discord.ApplicationCommandResponse,
): Effect.Effect<ApplicationCommand, ApplicationCommandRemoteShapeUnsupported> => {
  const key = `${command.type}:${command.name}`
  const unsupportedCommandFields = [
    command.name_localized === undefined,
    command.name_localizations === undefined || command.name_localizations === null,
    command.description_localized === undefined,
    command.description_localizations === undefined || command.description_localizations === null,
    command.dm_permission === undefined,
    command.handler === undefined,
  ].every(Boolean) === false
  if (unsupportedCommandFields) return unsupported(key, "unsupported command metadata")
  if (command.contexts === null) return unsupported(key, "null interaction contexts")

  const options: Array<ApplicationCommand["options"][number]> = []
  for (const option of command.options ?? []) {
    if (option.type !== Discord.ApplicationCommandOptionType.STRING) {
      return unsupported(key, `unsupported option type ${option.type} for ${option.name}`)
    }
    if (
      option.name_localized !== undefined ||
      (option.name_localizations !== undefined && option.name_localizations !== null) ||
      option.description_localized !== undefined ||
      (option.description_localizations !== undefined && option.description_localizations !== null)
    ) {
      return unsupported(key, `unsupported localized option metadata for ${option.name}`)
    }
    if (option.choices?.some(choice =>
      choice.name_localized !== undefined ||
      (choice.name_localizations !== undefined && choice.name_localizations !== null)
    ) === true) {
      return unsupported(key, `unsupported localized choice metadata for ${option.name}`)
    }
    options.push({
      type: Discord.ApplicationCommandOptionType.STRING,
      name: option.name,
      description: option.description,
      required: option.required === true,
      ...(option.autocomplete === undefined ? {} : { autocomplete: option.autocomplete }),
      ...(option.choices === undefined
        ? {}
        : { choices: option.choices.map(choice => ({ name: choice.name, value: choice.value })) }),
      ...(option.min_length === undefined ? {} : { minLength: option.min_length }),
      ...(option.max_length === undefined ? {} : { maxLength: option.max_length }),
    })
  }

  return Effect.succeed({
    type: command.type,
    name: command.name,
    description: command.description,
    options,
    defaultMemberPermissions: command.default_member_permissions,
    nsfw: command.nsfw === true,
    ...(command.integration_types === undefined
      ? {}
      : { integrationTypes: [...command.integration_types] }),
    ...(command.contexts === undefined ? {} : { contexts: [...command.contexts] }),
  })
}

const unsupported = (commandKey: string, detail: string) =>
  Effect.fail(new ApplicationCommandRemoteShapeUnsupported({
    commandKey,
    message: `Discord returned ${detail}; refusing to reconcile a lossy command projection`,
  }))

const mapRestError = (
  operation: ApplicationCommandRestError["operation"],
  scope: ApplicationCommandScope,
) => Effect.mapError((cause: unknown) =>
  new ApplicationCommandRestError({
    operation,
    scope: scope._tag === "GuildCommandScope" ? "guild" : "global",
    message: `Discord failed to ${operation} ${scope._tag === "GuildCommandScope" ? "guild" : "global"} application commands`,
    cause,
  }))
