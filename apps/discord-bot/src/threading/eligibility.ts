import type {
  AutomaticRejectionReason,
  SourceChannelKind,
  ThreadCandidate,
} from "./model.ts"

export interface AutomaticThreadPolicyConfig {
  readonly environment: string
  readonly guildId: string
  readonly parentChannelIds: ReadonlySet<string>
  readonly admittedParentKinds: ReadonlySet<SourceChannelKind>
  readonly legacyCommands: ReadonlySet<string>
}

export type AutomaticThreadDecision =
  | Readonly<{ _tag: "Eligible" }>
  | Readonly<{ _tag: "Rejected"; reason: AutomaticRejectionReason }>

export type ContentRejectionReason = Extract<
  AutomaticRejectionReason,
  | "empty"
  | "greeting"
  | "reaction"
  | "recognized_command"
  | "url_only"
  | "numeric_or_version_only"
  | "reaction_symbols_only"
>

const greetingVocabulary = new Set([
  "hi",
  "hello",
  "hey",
  "wave to say hi",
  "welcome",
  "good morning",
  "good evening",
])
const reactionVocabulary = new Set([
  "thanks",
  "thank",
  "thank you",
  "thx",
  "ty",
  "lol",
  "lmao",
  "nice",
  "cool",
  "ok",
  "okay",
  "yes",
  "no",
  "+1",
])
const topLevelGuildKinds = new Set<SourceChannelKind>(["GuildText", "GuildAnnouncement"])

/** Stable, reason-coded automatic admission policy shared by runtime and tooling. */
export const evaluateAutomaticThread = (
  candidate: ThreadCandidate,
  config: AutomaticThreadPolicyConfig,
): AutomaticThreadDecision => {
  const structuralReason = classifySource(candidate, config, false)
  if (structuralReason !== undefined) return rejected(structuralReason)

  const contentReason = classifyContent(candidate, config)
  return contentReason === undefined ? { _tag: "Eligible" } : rejected(contentReason)
}

/** Intentional triggers may select replies and low-information messages. */
export const classifyIntentionalSource = (
  candidate: ThreadCandidate,
  config: AutomaticThreadPolicyConfig,
): AutomaticRejectionReason | undefined => classifySource(candidate, config, true)

/** Pure classifier kept public for CLI explain and fixture generation. */
export const classifyContent = (
  candidate: Pick<ThreadCandidate, "content" | "attachmentCount" | "hasPoll" | "stickerCount">,
  config: Pick<AutomaticThreadPolicyConfig, "legacyCommands">,
): ContentRejectionReason | undefined => {
  const normalized = normalizeWhitespace(candidate.content)
  const hasRichContent = candidate.attachmentCount > 0 || candidate.hasPoll

  if (normalized.length === 0) {
    return hasRichContent === true ? undefined : candidate.stickerCount > 0 ? "reaction_symbols_only" : "empty"
  }

  const exactPhrase = normalizeExactPhrase(normalized)
  if (greetingVocabulary.has(exactPhrase) === true) return "greeting"
  if (reactionVocabulary.has(exactPhrase) === true) return "reaction"
  if (isRecognizedCommand(normalized, config.legacyCommands) === true) return "recognized_command"
  if (hasRichContent === true) return undefined
  if (isUrlOnly(normalized) === true) return "url_only"
  if (isNumericOrVersionOnly(normalized) === true) return "numeric_or_version_only"
  if (isReactionSymbolsOnly(normalized) === true) return "reaction_symbols_only"
  return undefined
}

export const normalizeWhitespace = (content: string): string => content.normalize("NFKC").replace(/\s+/gu, " ").trim()

const classifySource = (
  candidate: ThreadCandidate,
  config: AutomaticThreadPolicyConfig,
  intentional: boolean,
): AutomaticRejectionReason | undefined => {
  if (candidate.environment !== config.environment) return "wrong_environment"
  if (candidate.source.guildId !== config.guildId) return "wrong_guild"
  if (config.parentChannelIds.has(candidate.source.channelId) === false) return "parent_channel_not_configured"
  if (isGuildChannelKind(candidate.sourceChannelKind) === false) return "source_is_thread_or_dm"
  if (config.admittedParentKinds.has(candidate.sourceChannelKind) === false || topLevelGuildKinds.has(candidate.sourceChannelKind) === false) {
    return "unsupported_channel_kind"
  }
  if (intentional === false && (candidate.messageKind === "Reply" || candidate.hasMessageReference === true)) return "reply"
  if (candidate.messageKind === "System") return "non_ordinary_message"
  if (candidate.authorKind === "Bot") return "bot_author"
  if (candidate.authorKind === "Webhook") return "webhook_author"
  if (candidate.authorKind === "Application") return "application_author"
  if (candidate.existingThreadId !== undefined) return "existing_thread"
  return undefined
}

const normalizeExactPhrase = (content: string): string =>
  content.toLocaleLowerCase("en-US").replace(/[.!?,;:]{1,3}$/u, "").trim()

const isRecognizedCommand = (content: string, legacyCommands: ReadonlySet<string>): boolean => {
  const firstToken = content.split(" ", 1)[0]?.toLocaleLowerCase("en-US")
  return firstToken !== undefined && legacyCommands.has(firstToken)
}

const isUrlOnly = (content: string): boolean =>
  content.split(" ").every((token) => {
    const candidate = token.startsWith("<") === true && token.endsWith(">") === true ? token.slice(1, -1) : token
    try {
      const url = new URL(candidate)
      return url.protocol === "https:" || url.protocol === "http:"
    } catch {
      return false
    }
  })

const isNumericOrVersionOnly = (content: string): boolean =>
  /^[+-]?\d+(?:[.,]\d+)*$/u.test(content) || /^v?\d+(?:\.\d+){1,3}(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu.test(content)

const isReactionSymbolsOnly = (content: string): boolean =>
  content
    .replace(/<a?:[a-zA-Z0-9_]+:\d+>/gu, "")
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, "")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\u20E3\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[\p{P}\p{S}\s]/gu, "").length === 0

const isGuildChannelKind = (kind: SourceChannelKind): boolean =>
  kind === "GuildText" || kind === "GuildAnnouncement" || kind === "GuildForum" || kind === "GuildMedia"

const rejected = (reason: AutomaticRejectionReason): AutomaticThreadDecision => ({ _tag: "Rejected", reason })
