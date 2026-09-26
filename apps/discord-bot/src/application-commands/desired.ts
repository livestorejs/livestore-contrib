import { Discord } from 'dfx'

import { docsCommandDescription } from '../docs/disclosure.ts'
import type { ApplicationCommand, ApplicationCommandScope } from './model.ts'

/** The sole desired-state declaration for every Discord command served by the bot. */
export const desiredApplicationCommands = [
  {
    type: Discord.ApplicationCommandType.CHAT,
    name: 'docs',
    description: docsCommandDescription,
    options: [
      {
        type: Discord.ApplicationCommandOptionType.STRING,
        name: 'query',
        description: 'Question to answer from the LiveStore documentation',
        required: true,
      },
    ],
    defaultMemberPermissions: null,
    nsfw: false,
  },
  {
    type: Discord.ApplicationCommandType.MESSAGE,
    name: 'Create Thread',
    description: '',
    options: [],
    // Discord-level gate intentionally absent: a non-null default member permission would hide
    // the action entirely from unprivileged members, making the server-side ephemeral denial in
    // runtime/handlers.ts unreachable UX. Authorization is enforced at execution instead.
    defaultMemberPermissions: null,
    nsfw: false,
  },
] as const satisfies ReadonlyArray<ApplicationCommand>

/** DFX request projection. Global commands are explicitly guild-install/guild-context only. */
export const toDiscordCommandRequest = (
  command: ApplicationCommand,
  scope: ApplicationCommandScope,
): Discord.ApplicationCommandCreateRequest => ({
  type: command.type,
  name: command.name,
  description: command.description,
  options: command.options.map((option) => ({
    type: option.type,
    name: option.name,
    description: option.description,
    required: option.required,
    ...(option.autocomplete === undefined ? {} : { autocomplete: option.autocomplete }),
    ...(option.choices === undefined ? {} : { choices: option.choices }),
    ...(option.minLength === undefined ? {} : { min_length: option.minLength }),
    ...(option.maxLength === undefined ? {} : { max_length: option.maxLength }),
  })),
  default_member_permissions:
    command.defaultMemberPermissions === null ? null : Number(command.defaultMemberPermissions),
  ...(scope._tag === 'GlobalCommandScope'
    ? {
        integration_types: command.integrationTypes ?? [Discord.ApplicationIntegrationType.GUILD_INSTALL],
        contexts: command.contexts ?? [Discord.InteractionContextType.GUILD],
      }
    : {}),
})
