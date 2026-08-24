import { createHash, randomUUID } from "node:crypto"

export type Snowflake = string & { readonly Snowflake: unique symbol }
export type RunId = string & { readonly RunId: unique symbol }

export const topicSentinel = "livestore-discord-e2e-only"
export const liveWriteConfirmation = "I_UNDERSTAND_THIS_WRITES_TO_DISCORD_STAGING"

export type ScenarioId =
  | "automatic-eligible"
  | "automatic-filtered"
  | "automated-author-rejected"
  | "operator-retroactive"
  | "operator-idempotent"
  | "operator-concurrent"
  | "message-action-authorized"
  | "message-action-denied"
  | "docs-public"
  | "docs-role-restricted"
  | "docs-denied"

export type Executor = "automated" | "human-assisted"
export type Verdict = "PASS" | "FAIL" | "UNRUN"
export type CleanupStatus = "not-needed" | "deleted" | "failed"

export interface ScenarioDefinition {
  readonly id: ScenarioId
  readonly executor: Executor
  readonly description: string
}

export const scenarioMatrix: ReadonlyArray<ScenarioDefinition> = [
  {
    id: "automatic-eligible",
    executor: "human-assisted",
    description: "An eligible top-level message creates one correlated public thread.",
  },
  {
    id: "automatic-filtered",
    executor: "human-assisted",
    description: "A reason-coded low-information message creates no thread.",
  },
  {
    id: "automated-author-rejected",
    executor: "automated",
    description: "A substantive message from the actor bot creates no thread.",
  },
  {
    id: "operator-retroactive",
    executor: "automated",
    description: "The control CLI creates a thread for an existing message by ID.",
  },
  {
    id: "operator-idempotent",
    executor: "automated",
    description: "Repeating the same control request creates no second thread.",
  },
  {
    id: "operator-concurrent",
    executor: "automated",
    description: "Concurrent control requests converge on exactly one thread.",
  },
  {
    id: "message-action-authorized",
    executor: "human-assisted",
    description: "An authorized Create Thread message action creates a correlated thread.",
  },
  {
    id: "message-action-denied",
    executor: "human-assisted",
    description: "An unauthorized Create Thread message action is denied without mutation.",
  },
  {
    id: "docs-public",
    executor: "human-assisted",
    description: "A member can use /docs in a declared public docs channel.",
  },
  {
    id: "docs-role-restricted",
    executor: "human-assisted",
    description: "A contributor or maintainer can use /docs in an additional restricted channel.",
  },
  {
    id: "docs-denied",
    executor: "human-assisted",
    description: "An unprivileged member is denied in a restricted docs channel.",
  },
]

export interface ChannelSnapshot {
  readonly id: Snowflake
  readonly guildId: Snowflake
  readonly topic: string | undefined
}

export interface MessageSnapshot {
  readonly id: Snowflake
  readonly channelId: Snowflake
  readonly marker: string
  readonly author: "human" | "automated-actor"
}

export interface ThreadSnapshot {
  readonly id: Snowflake
  readonly guildId: Snowflake
  readonly parentChannelId: Snowflake
  readonly sourceMessageId: Snowflake
  readonly marker: string
}

export interface ResponseSnapshot {
  readonly id: Snowflake
  readonly channelId: Snowflake
  readonly marker: string
  readonly hasAnswer: boolean
  readonly hasSources: boolean
}

export interface StagingTarget {
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly allowedChannelIds: ReadonlySet<Snowflake>
  readonly requiredTopicSentinel: string
  readonly pollIntervalMs: number
  readonly timeoutMs: number
}

export interface ArtifactCleanup {
  readonly sourceMessage: CleanupStatus
  readonly thread: CleanupStatus
  readonly response: CleanupStatus
}

export interface ScenarioReceipt {
  readonly scenario: ScenarioId
  readonly executor: Executor
  readonly verdict: Verdict
  readonly reason:
    | "assertions-passed"
    | "official-automation-unavailable"
    | "prerequisite-missing"
    | "target-denied"
    | "target-mismatch"
    | "assertion-failed"
    | "transport-failed"
    | "cleanup-failed"
  readonly targetHash: string
  readonly markerHash: string
  readonly artifactHashes: ReadonlyArray<string>
  readonly cleanup: ArtifactCleanup
}

export interface RunReceipt {
  readonly schemaVersion: 1
  readonly runId: RunId
  readonly environment: "fake" | "staging"
  readonly startedAt: string
  readonly finishedAt: string
  readonly scenarios: ReadonlyArray<ScenarioReceipt>
  readonly verdict: Verdict
}

export const makeRunId = (): RunId => randomUUID() as RunId

export const makeMarker = (runId: RunId, scenario: ScenarioId): string =>
  `[livestore-discord-e2e:${runId}:${scenario}]`

/** Produces receipt correlation without persisting Discord content or identifiers. */
export const opaqueHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16)

export const aggregateVerdict = (receipts: ReadonlyArray<ScenarioReceipt>): Verdict =>
  receipts.some((receipt) => receipt.verdict === "FAIL") === true
    ? "FAIL"
    : receipts.some((receipt) => receipt.verdict === "UNRUN") === true
      ? "UNRUN"
      : "PASS"
