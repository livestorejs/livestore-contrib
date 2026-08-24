import { Effect, Schema } from "effect"
import { normalizeWhitespace } from "./eligibility.ts"
import { ThreadName, type ThreadCandidate } from "./model.ts"

export class TitleProposalError extends Schema.TaggedError<TitleProposalError>()("TitleProposalError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export interface ThreadTitlePort {
  readonly propose: (input: string) => Effect.Effect<string, TitleProposalError>
}

export interface ThreadTitleConfig {
  readonly aiTitleChannelIds: ReadonlySet<string>
}

const maxProviderInputCodePoints = 500
const maxThreadNameCodePoints = 100
const fallbackTitle = "Discussion"

/** Projects only the disclosed source-body subset; no metadata is accepted. */
export const projectAiTitleInput = (content: string): string | undefined => {
  const redacted = normalizeWhitespace(content)
    .replace(/<@!?\d+>/gu, "[user]")
    .replace(/<@&\d+>/gu, "[role]")
    .replace(/<#\d+>/gu, "[channel]")
    .replace(/<a?:[a-zA-Z0-9_]+:\d+>/gu, "[emoji]")
    .replace(/<?https?:\/\/[^\s>]+>?/giu, "[link]")
  const bounded = takeCodePoints(normalizeWhitespace(redacted), maxProviderInputCodePoints)
  const meaningful = bounded.replace(/\[(?:user|role|channel|emoji|link)\]/gu, "").replace(/[\p{P}\p{S}\s]/gu, "")
  return meaningful.length === 0 ? undefined : bounded
}

/** Validates an external or operator proposal without silently repairing it. */
export const validateThreadName = (proposal: string): ThreadName | undefined => {
  const normalized = normalizeWhitespace(proposal)
  if (normalized.length === 0 || [...normalized].length > maxThreadNameCodePoints || /\p{C}/u.test(normalized)) return undefined
  return Schema.decodeUnknownSync(ThreadName)(normalized)
}

/** Local naming is deterministic and cannot fail thread creation. */
export const deriveLocalThreadName = (content: string): ThreadName => {
  const normalized = normalizeWhitespace(content).replace(/\p{C}/gu, "")
  const bounded = takeCodePoints(normalized, maxThreadNameCodePoints)
  return Schema.decodeUnknownSync(ThreadName)(bounded.length === 0 ? fallbackTitle : bounded)
}

export const resolveThreadName = Effect.fn("threading.resolveThreadName")(
  function* (candidate: ThreadCandidate, config: ThreadTitleConfig, port: ThreadTitlePort) {
    if (candidate.trigger._tag === "Operator" && candidate.trigger.requestedTitle !== undefined) {
      return validateThreadName(candidate.trigger.requestedTitle) ?? deriveLocalThreadName(candidate.content)
    }

    if (!config.aiTitleChannelIds.has(candidate.source.channelId)) return deriveLocalThreadName(candidate.content)
    const input = projectAiTitleInput(candidate.content)
    if (input === undefined) return deriveLocalThreadName(candidate.content)

    const proposal = yield* port.propose(input).pipe(Effect.option)
    if (proposal._tag === "Some") {
      const validated = validateThreadName(proposal.value)
      if (validated !== undefined) return validated
    }
    return deriveLocalThreadName(candidate.content)
  },
)

const takeCodePoints = (value: string, count: number): string => [...value].slice(0, count).join("")
