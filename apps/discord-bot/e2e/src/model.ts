import { createHash, randomUUID } from 'node:crypto'

export type Snowflake = string & { readonly Snowflake: unique symbol }
export type RunId = string & { readonly RunId: unique symbol }

export const topicSentinel = 'livestore-discord-e2e-only'
export const liveWriteConfirmation = 'I_UNDERSTAND_THIS_WRITES_TO_DISCORD_STAGING'

export type ScenarioId =
  | 'automatic-eligible'
  | 'automatic-filtered'
  | 'automated-author-rejected'
  | 'operator-retroactive'
  | 'operator-idempotent'
  | 'operator-concurrent'
  | 'message-action-authorized'
  | 'message-action-denied'
  | 'docs-public'
  | 'docs-role-restricted'
  | 'docs-denied'

/**
 * Legacy command the staging config must list in `legacyCommands`. Message-action
 * sources use it so the automatic path rejects them (`recognized_command`) while
 * the row stays plain text: the broker reveals the message toolbar by clicking the
 * row, and on a URL-only row that click lands on the link.
 */
export const e2eLegacyCommand = '!livestore-e2e'

export type Executor = 'automated' | 'human-assisted'
export type Verdict = 'PASS' | 'FAIL' | 'UNRUN'
export type CleanupStatus = 'not-needed' | 'deleted' | 'failed'
export type AssertionVerdict = 'passed' | 'failed' | 'not-reached'
export type CleanupFailureCause =
  | { readonly kind: 'rest'; readonly status?: number; readonly discordCode?: number }
  | { readonly kind: 'broker'; readonly reason: string; readonly exitCode: number; readonly step?: number }
  | { readonly kind: 'unknown' }

export interface ScenarioDefinition {
  readonly id: ScenarioId
  readonly executor: Executor
  readonly description: string
}

export const scenarioMatrix: ReadonlyArray<ScenarioDefinition> = [
  {
    id: 'automatic-eligible',
    executor: 'human-assisted',
    description: 'An eligible top-level message creates one correlated public thread.',
  },
  {
    id: 'automatic-filtered',
    executor: 'human-assisted',
    description: 'A reason-coded low-information message creates no thread.',
  },
  {
    id: 'automated-author-rejected',
    executor: 'automated',
    description: 'A substantive message from the actor bot creates no thread.',
  },
  {
    id: 'operator-retroactive',
    executor: 'automated',
    description: 'The control CLI creates a thread for an existing message by ID.',
  },
  {
    id: 'operator-idempotent',
    executor: 'automated',
    description: 'Repeating the same control request creates no second thread.',
  },
  {
    id: 'operator-concurrent',
    executor: 'automated',
    description: 'Concurrent control requests converge on exactly one thread.',
  },
  {
    id: 'message-action-authorized',
    executor: 'human-assisted',
    description: 'An authorized Create Thread message action creates a correlated thread.',
  },
  {
    id: 'message-action-denied',
    executor: 'human-assisted',
    description: 'An unauthorized Create Thread message action is denied without mutation.',
  },
  {
    id: 'docs-public',
    executor: 'human-assisted',
    description: 'A member can use /docs in a declared public docs channel.',
  },
  {
    id: 'docs-role-restricted',
    executor: 'human-assisted',
    description: 'A contributor or maintainer can use /docs in an additional restricted channel.',
  },
  {
    id: 'docs-denied',
    executor: 'human-assisted',
    description: 'An unprivileged member is denied in a restricted docs channel.',
  },
]

export type ScenarioRung = 'tracer' | 'unattended' | 'attended' | 'full'

export type ScenarioSelection =
  | { readonly _tag: 'Rung'; readonly rung: ScenarioRung }
  | { readonly _tag: 'Scenarios'; readonly scenarios: ReadonlyArray<ScenarioId> }

export const scenarioRungs: ReadonlyArray<ScenarioRung> = ['tracer', 'unattended', 'attended', 'full']

export const fullScenarioSelection: ScenarioSelection = { _tag: 'Rung', rung: 'full' }

export const isScenarioId = (value: string): value is ScenarioId =>
  scenarioMatrix.some((scenario) => scenario.id === value)

export const isScenarioRung = (value: string): value is ScenarioRung => scenarioRungs.some((rung) => rung === value)

export const scenarioIdsForSelection = (selection: ScenarioSelection): ReadonlyArray<ScenarioId> => {
  if (selection._tag === 'Scenarios') return selection.scenarios

  switch (selection.rung) {
    case 'tracer':
      return ['automated-author-rejected', 'operator-retroactive']
    case 'unattended':
      return ['automated-author-rejected', 'operator-retroactive', 'operator-idempotent', 'operator-concurrent']
    case 'attended':
      return [
        'automatic-eligible',
        'automatic-filtered',
        'message-action-authorized',
        'message-action-denied',
        'docs-public',
        'docs-role-restricted',
        'docs-denied',
      ]
    case 'full':
      return scenarioMatrix.map((scenario) => scenario.id)
  }
}

export interface ChannelSnapshot {
  readonly id: Snowflake
  readonly guildId: Snowflake
  readonly topic: string | undefined
}

export interface MessageSnapshot {
  readonly id: Snowflake
  readonly channelId: Snowflake
  readonly marker: string
  readonly author: 'human' | 'automated-actor'
}

export interface ThreadSnapshot {
  readonly id: Snowflake
  readonly name: string
  readonly guildId: Snowflake
  readonly parentChannelId: Snowflake
  readonly sourceMessageId: Snowflake
  readonly marker: string
}

export type ResponseSnapshot = {
  readonly channelId: Snowflake
  readonly marker: string
  readonly hasAnswer: boolean
  readonly hasSources: boolean
} & ({ readonly id: Snowflake; readonly ephemeral?: false } | { readonly id?: never; readonly ephemeral: true })

export interface StagingTarget {
  /** Staging application that authored the interaction replies (not the observer bot). */
  readonly applicationId: Snowflake
  readonly guildId: Snowflake
  /** Threading, message-action, and operator-control target. */
  readonly channelId: Snowflake
  readonly expectAiTitles?: boolean
  readonly docsChannelIds: {
    readonly public: Snowflake
    readonly restricted: Snowflake
  }
  readonly allowedChannelIds: ReadonlySet<Snowflake>
  readonly requiredTopicSentinel: string
  readonly pollIntervalMs: number
  readonly timeoutMs: number
}

export interface ArtifactCleanup {
  readonly sourceMessage: CleanupStatus
  readonly thread: CleanupStatus
  readonly response: CleanupStatus
  readonly failures?: ReadonlyArray<CleanupFailure>
}
export interface CleanupFailure {
  readonly artifact: 'sourceMessage' | 'thread' | 'response'
  readonly cause: CleanupFailureCause
}

export type ScenarioFailureStep =
  | 'createOwnedMessage'
  | 'findThreadForMessage'
  | 'operatorCreateThread'
  | 'invokeMessageAction'
  | 'invokeDocs'
  | 'assertions'

export interface ScenarioFailure {
  readonly step: ScenarioFailureStep
  readonly errorClass:
    | 'AdminControlFailure'
    | 'DiscordRestFailure'
    | 'BrokerOperationFailure'
    | 'E2EPrerequisiteUnavailableError'
    | 'Error'
    | 'Unknown'
  readonly message:
    | 'admin-unreachable'
    | 'admin-http-error'
    | 'invalid-control-result'
    | 'discord-rest-failed'
    | 'broker-failed'
    | 'prerequisite-unavailable'
    | 'control-result-unexpected'
    | 'source-correlation-failed'
    | 'unexpected-error'
  readonly httpStatus?: number
  readonly controlResultTag?: string
  /** Fixed server-owned wording or a bounded code suffix; unrecognized bodies become `other`. */
  readonly serverMessage?: string
  /** Allowlisted broker or REST cause, same shape as cleanup failures. */
  readonly cause?: CleanupFailureCause
}

export interface ScenarioReceipt {
  readonly scenario: ScenarioId
  readonly executor: Executor
  readonly verdict: Verdict
  readonly assertions: AssertionVerdict
  readonly reason:
    | 'assertions-passed'
    | 'official-automation-unavailable'
    | 'prerequisite-missing'
    | 'not-selected'
    | 'target-denied'
    | 'target-mismatch'
    | 'assertion-failed'
    | 'transport-failed'
    | 'cleanup-failed'
  readonly targetHash: string
  readonly markerHash: string
  readonly artifactHashes: ReadonlyArray<string>
  readonly cleanup: ArtifactCleanup
  readonly failure?: ScenarioFailure
}

export interface RunReceipt {
  readonly schemaVersion: 2
  readonly runId: RunId
  readonly environment: 'fake' | 'staging'
  readonly startedAt: string
  readonly finishedAt: string
  readonly scenarios: ReadonlyArray<ScenarioReceipt>
  readonly verdict: Verdict
}

export const makeRunId = (): RunId => randomUUID() as RunId

export const makeMarker = (runId: RunId, scenario: ScenarioId): string => `[livestore-discord-e2e:${runId}:${scenario}]`

/** Produces receipt correlation without persisting Discord content or identifiers. */
export const opaqueHash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

export const aggregateVerdict = (receipts: ReadonlyArray<ScenarioReceipt>): Verdict => {
  let hasSelectedReceipt = false
  let hasUnrunReceipt = false
  for (const receipt of receipts) {
    if (receipt.reason === 'not-selected') continue
    hasSelectedReceipt = true
    if (receipt.verdict === 'FAIL') return 'FAIL'
    if (receipt.verdict === 'UNRUN') hasUnrunReceipt = true
  }
  return hasSelectedReceipt === false || hasUnrunReceipt === true ? 'UNRUN' : 'PASS'
}
