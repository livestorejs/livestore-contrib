import { describe, it } from "@effect/vitest"
import { Discord } from "dfx"
import { ChannelType, GuildMemberFlags, Locale } from "discord-api-types/v10"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { expect } from "vitest"
import type {
  AutomaticMessage,
  CreateThreadInteraction,
  DiscordEventHandlersService,
  DocsInteraction,
} from "./events.ts"
import { routeInteraction, routeMessage } from "./routes.ts"

describe("DFX dispatch routes", () => {
  it.effect("decodes message, message action, and docs command into narrow inputs", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<Recorded>({ automatic: [], manual: [], docs: [] })
      const handlers = makeRecordingHandlers(recorded)

      yield* routeMessage(messageEvent.d, handlers)
      yield* routeInteraction(createThreadInteraction, handlers)
      yield* routeInteraction(docsInteraction, handlers)

      const result = yield* Ref.get(recorded)
      expect(result.automatic).toHaveLength(1)
      expect(result.automatic[0]).toMatchObject({
        guildId: guildId,
        channelId,
        messageId,
        content: "How do I sync across tabs?",
        authorIsBot: false,
      })
      expect(result.manual).toHaveLength(1)
      expect(result.manual[0]).toMatchObject({
        guildId,
        channelId,
        sourceMessage: { messageId },
        actor: { userId, effectivePermissions: "34359738368" },
      })
      expect(result.docs).toHaveLength(1)
      expect(result.docs[0]).toMatchObject({
        guildId,
        channelId,
        query: "What is an event?",
      })
    }),
  )

  it.effect("ignores direct messages and unrelated commands", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<Recorded>({ automatic: [], manual: [], docs: [] })
      const handlers = makeRecordingHandlers(recorded)
      const { guild_id: _guildId, ...directMessage } = messageEvent.d

      yield* routeMessage(directMessage, handlers)
      yield* routeInteraction(
        makeDocsInteraction("unrelated"),
        handlers,
      )

      expect(yield* Ref.get(recorded)).toEqual({ automatic: [], manual: [], docs: [] })
    }),
  )
})

interface Recorded {
  readonly automatic: ReadonlyArray<AutomaticMessage>
  readonly manual: ReadonlyArray<CreateThreadInteraction>
  readonly docs: ReadonlyArray<DocsInteraction>
}

const makeRecordingHandlers = (recorded: Ref.Ref<Recorded>): DiscordEventHandlersService => ({
  onAutomaticMessage: input =>
    Ref.update(recorded, current => ({
      ...current,
      automatic: [...current.automatic, input],
    })),
  onCreateThreadInteraction: input =>
    Ref.update(recorded, current => ({
      ...current,
      manual: [...current.manual, input],
    })),
  onDocsInteraction: input =>
    Ref.update(recorded, current => ({
      ...current,
      docs: [...current.docs, input],
    })),
})

const applicationId = "100000000000000002"
const messageId = "100000000000000003"
const channelId = "100000000000000004"
const guildId = "100000000000000005"
const userId = "100000000000000006"
const interactionId = "100000000000000007"

const user = {
  id: userId,
  username: "alice",
  discriminator: "0",
  avatar: null,
  global_name: "Alice",
  public_flags: 0,
  flags: 0,
  primary_guild: null,
}

const sourceMessage = {
  id: messageId,
  channel_id: channelId,
  guild_id: guildId,
  author: user,
  content: "How do I sync across tabs?",
  timestamp: "2026-08-23T12:00:00.000Z",
  edited_timestamp: null,
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  attachments: [],
  embeds: [],
  components: [],
  flags: 0,
  pinned: false,
  type: Discord.MessageType.DEFAULT,
}

const messageEvent: Discord.GatewayMessageCreateDispatch = {
  op: Discord.GatewayOpcodes.Dispatch,
  s: 2,
  t: Discord.GatewayDispatchEvents.MessageCreate,
  d: sourceMessage,
}

const interactionBase = {
  id: interactionId,
  application_id: applicationId,
  type: Discord.InteractionTypes.APPLICATION_COMMAND,
  guild_id: guildId,
  channel_id: channelId,
  channel: { id: channelId, type: ChannelType.GuildText as const },
  member: {
    user,
    roles: [],
    joined_at: "2026-08-23T12:00:00.000Z",
    deaf: false,
    mute: false,
    permissions: "34359738368",
    flags: GuildMemberFlags.DidRejoin,
  },
  token: "prototype-interaction-token",
  version: 1 as const,
  app_permissions: "34359738368",
  locale: Locale.EnglishUS,
  guild_locale: Locale.EnglishUS,
  entitlements: [],
  authorizing_integration_owners: {},
  attachment_size_limit: 10_485_760,
}

const createThreadInteraction: Discord.GatewayInteractionCreateDispatchData = {
  ...interactionBase,
  data: {
    id: "100000000000000008",
    name: "Create Thread",
    type: Discord.ApplicationCommandType.MESSAGE,
    target_id: messageId,
    resolved: { messages: { [messageId]: sourceMessage } },
  },
}

const makeDocsInteraction = (
  name: string,
): Discord.GatewayInteractionCreateDispatchData => ({
  ...interactionBase,
  data: {
    id: "100000000000000009",
    name,
    type: Discord.ApplicationCommandType.CHAT,
    options: [
      {
        name: "query",
        type: Discord.ApplicationCommandOptionType.STRING,
        value: "What is an event?",
      },
    ],
  },
})

const docsInteraction = makeDocsInteraction("docs")
