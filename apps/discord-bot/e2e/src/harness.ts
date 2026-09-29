import { DiscordRestFailure } from '../../src/discord/rest-error-redaction.ts'
import { deriveLocalThreadName, validateThreadName } from '../../src/threading/title.ts'
import { AdminControlFailure, safeControlTags, safeServerMessage } from './admin-http-client.ts'
import { BrokerOperationFailure } from './human-handoff.ts'
import {
  aggregateVerdict,
  fullScenarioSelection,
  makeMarker,
  makeRunId,
  opaqueHash,
  e2eLegacyCommand,
  scenarioIdsForSelection,
  scenarioMatrix,
  type ArtifactCleanup,
  type CleanupFailureCause,
  type MessageSnapshot,
  type ResponseSnapshot,
  type RunReceipt,
  type ScenarioDefinition,
  type ScenarioFailure,
  type ScenarioReceipt,
  type ScenarioSelection,
  type Snowflake,
  type StagingTarget,
  type ThreadSnapshot,
} from './model.ts'
import { E2EPrerequisiteUnavailableError, type E2ETransport } from './transport.ts'

interface OwnedArtifacts {
  source: MessageSnapshot | undefined
  thread: ThreadSnapshot | undefined
  responses: ReadonlyArray<ResponseSnapshot>
}

const noCleanup: ArtifactCleanup = {
  sourceMessage: 'not-needed',
  thread: 'not-needed',
  response: 'not-needed',
}

const pollForThread = async (
  transport: E2ETransport,
  target: StagingTarget,
  sourceMessageId: Snowflake,
): Promise<ThreadSnapshot | undefined> => {
  const deadline = Date.now() + target.timeoutMs
  while (Date.now() < deadline) {
    const thread = await transport.findThreadForMessage(target.guildId, sourceMessageId)
    if (thread !== undefined) return thread
    await new Promise<void>((resolve) => setTimeout(resolve, target.pollIntervalMs))
  }
  return undefined
}

const isOwnedThread = (
  thread: ThreadSnapshot,
  source: Pick<MessageSnapshot, 'id'>,
  target: StagingTarget,
  marker: string,
  parentChannelId: Snowflake = target.channelId,
): boolean =>
  thread.id === source.id &&
  thread.sourceMessageId === source.id &&
  thread.parentChannelId === parentChannelId &&
  thread.guildId === target.guildId &&
  thread.marker === marker

const cleanupCause = (error: unknown): CleanupFailureCause => {
  if (error instanceof BrokerOperationFailure) {
    if (error.reason === 'discord-rest')
      return {
        kind: 'rest',
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.discordCode === undefined ? {} : { discordCode: error.discordCode }),
      }
    return {
      kind: 'broker',
      reason:
        /^(?:broker-exit|operator-declined|capture-(?:navigate|wait|click|evaluate|press|fill|type)-failed)$/u.test(
          error.reason,
        ) === true
          ? error.reason
          : 'broker-exit',
      exitCode: error.exitCode,
      ...(error.step === undefined ? {} : { step: error.step }),
    }
  }
  if (error instanceof DiscordRestFailure)
    return {
      kind: 'rest',
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.discordCode === undefined ? {} : { discordCode: error.discordCode }),
    }
  return { kind: 'unknown' }
}

const scenarioFailure = (cause: unknown, step: ScenarioFailure['step']): ScenarioFailure => {
  if (cause instanceof AdminControlFailure) {
    return {
      step,
      errorClass: 'AdminControlFailure',
      message: cause.reason,
      ...(cause.status !== undefined &&
      Number.isInteger(cause.status) === true &&
      cause.status >= 100 &&
      cause.status <= 599
        ? { httpStatus: cause.status }
        : {}),
      ...(cause.controlResultTag !== undefined && Object.hasOwn(safeControlTags, cause.controlResultTag) === true
        ? { controlResultTag: cause.controlResultTag }
        : {}),
      ...(cause.reason === 'admin-http-error' ? { serverMessage: safeServerMessage(cause.serverMessage) } : {}),
    }
  }
  if (cause instanceof DiscordRestFailure)
    return {
      step,
      errorClass: 'DiscordRestFailure',
      message: 'discord-rest-failed',
      ...(cause.status === undefined ? {} : { httpStatus: cause.status }),
    }
  if (cause instanceof BrokerOperationFailure)
    return { step, errorClass: 'BrokerOperationFailure', message: 'broker-failed', cause: cleanupCause(cause) }
  if (cause instanceof E2EPrerequisiteUnavailableError)
    return { step, errorClass: 'E2EPrerequisiteUnavailableError', message: 'prerequisite-unavailable' }
  if (cause instanceof Error)
    return {
      step,
      errorClass: 'Error',
      message:
        cause.message === 'Created message did not correlate to the requested owner and scope'
          ? 'source-correlation-failed'
          : 'unexpected-error',
    }
  return { step, errorClass: 'Unknown', message: 'unexpected-error' }
}

const cleanup = async (
  transport: E2ETransport,
  target: StagingTarget,
  owned: OwnedArtifacts,
): Promise<ArtifactCleanup> => {
  const result: {
    sourceMessage: ArtifactCleanup['sourceMessage']
    thread: ArtifactCleanup['thread']
    response: ArtifactCleanup['response']
    failures: Array<{ artifact: 'sourceMessage' | 'thread' | 'response'; cause: CleanupFailureCause }>
  } = {
    sourceMessage: 'not-needed',
    thread: 'not-needed',
    response: 'not-needed',
    failures: [],
  }

  const deletableResponses = owned.responses.filter(
    (response): response is ResponseSnapshot & { readonly id: Snowflake } => response.id !== undefined,
  )
  if (deletableResponses.length > 0) {
    const unresolvedThreadSources = new Set<Snowflake>()
    for (const response of deletableResponses) {
      try {
        // A non-ephemeral response can itself become an automatic-thread source.
        const thread = await transport.findThreadForMessage(target.guildId, response.id)
        if (thread === undefined) continue
        if (isOwnedThread(thread, response, target, response.marker, response.channelId) === false) {
          throw new Error('Response thread identity did not match owned source')
        }
        await transport.deleteThread(thread.id)
        if (result.thread !== 'failed') result.thread = 'deleted'
      } catch (error) {
        result.thread = 'failed'
        unresolvedThreadSources.add(response.id)
        result.failures.push({ artifact: 'thread', cause: cleanupCause(error) })
      }
    }
    const outcomes = await Promise.allSettled(
      deletableResponses
        .filter((response) => unresolvedThreadSources.has(response.id) === false)
        .map((response) => transport.deleteResponse(response.channelId, response.id)),
    )
    result.response =
      unresolvedThreadSources.size > 0 || outcomes.some((outcome) => outcome.status === 'rejected') === true
        ? 'failed'
        : 'deleted'
    outcomes.forEach((outcome) => {
      if (outcome.status === 'rejected')
        result.failures.push({ artifact: 'response', cause: cleanupCause(outcome.reason) })
    })
  }
  if (owned.thread !== undefined && owned.source !== undefined) {
    try {
      await transport.deleteThread(owned.thread.id)
      if (result.thread !== 'failed') result.thread = 'deleted'
    } catch (error) {
      result.thread = 'failed'
      result.failures.push({ artifact: 'thread', cause: cleanupCause(error) })
    }
  }
  if (owned.source !== undefined) {
    try {
      await transport.deleteMessage(target.channelId, owned.source.id)
      result.sourceMessage = 'deleted'
    } catch (error) {
      result.sourceMessage = 'failed'
      result.failures.push({ artifact: 'sourceMessage', cause: cleanupCause(error) })
    }
  }
  return result
}

/** URL-only policy rejection with a literal correlation marker in the fragment. */
const filteredContent = (marker: string): string => `https://example.invalid/#${marker}`

/** `recognized_command` policy rejection as plain text, with a literal correlation marker. */
const commandContent = (marker: string): string => `${e2eLegacyCommand} ${marker}`

const runScenario = async (input: {
  readonly scenario: ScenarioDefinition
  readonly marker: string
  readonly transport: E2ETransport
  readonly target: StagingTarget
  readonly allowHumanAssisted: boolean
  readonly expectAiTitles: boolean
}): Promise<ScenarioReceipt> => {
  const { scenario, marker, transport, target } = input
  const base = {
    scenario: scenario.id,
    executor: scenario.executor,
    targetHash: opaqueHash(`${target.guildId}:${target.channelId}`),
    markerHash: opaqueHash(marker),
  } as const

  if (scenario.executor === 'human-assisted' && input.allowHumanAssisted === false) {
    return {
      ...base,
      verdict: 'UNRUN',
      assertions: 'not-reached',
      reason: 'official-automation-unavailable',
      artifactHashes: [],
      cleanup: noCleanup,
    }
  }

  const owned: OwnedArtifacts = { source: undefined, thread: undefined, responses: [] }
  let step: ScenarioFailure['step'] = 'createOwnedMessage'
  const createOwnedMessage = async (
    request: Parameters<E2ETransport['createMessage']>[0],
  ): Promise<MessageSnapshot> => {
    step = 'createOwnedMessage'
    const candidate = await transport.createMessage(request)
    if (
      candidate.channelId !== request.channelId ||
      candidate.marker !== request.marker ||
      candidate.author !== request.author
    ) {
      throw new Error('Created message did not correlate to the requested owner and scope')
    }
    owned.source = candidate
    return candidate
  }
  const ownResponses = (candidates: ReadonlyArray<ResponseSnapshot>, expectedChannelId = target.channelId): boolean => {
    const correlated = candidates.filter(
      (candidate) => candidate.channelId === expectedChannelId && candidate.marker === marker,
    )
    owned.responses = [...owned.responses, ...correlated]
    return candidates.length > 0 && correlated.length === candidates.length
  }
  let passed = false
  try {
    switch (scenario.id) {
      case 'automatic-eligible': {
        const content = `${marker} How does LiveStore sync between clients?`
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content,
          author: 'human',
        })
        step = 'findThreadForMessage'
        const candidate = await pollForThread(transport, target, source.id)
        if (candidate !== undefined && isOwnedThread(candidate, source, target, marker) === true) {
          owned.thread = candidate
          passed =
            input.expectAiTitles === false ||
            (validateThreadName(candidate.name) !== undefined && candidate.name !== deriveLocalThreadName(content))
        }
        break
      }
      case 'automatic-filtered': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          // A URL-only source remains policy-rejected while carrying the
          // literal marker needed for attended correlation and recovery.
          content: filteredContent(marker),
          author: 'human',
        })
        step = 'findThreadForMessage'
        const candidate = await pollForThread(transport, target, source.id)
        if (candidate !== undefined && isOwnedThread(candidate, source, target, marker) === true) {
          // This is a policy failure, but the exact source-anchored identity is
          // still sufficient to cleanup-own the unexpected artifact.
          owned.thread = candidate
        }
        passed = candidate === undefined
        break
      }
      case 'automated-author-rejected': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content: `${marker} How does LiveStore sync between clients?`,
          author: 'automated-actor',
        })
        step = 'findThreadForMessage'
        const candidate = await pollForThread(transport, target, source.id)
        if (candidate !== undefined && isOwnedThread(candidate, source, target, marker) === true) {
          owned.thread = candidate
        }
        passed = candidate === undefined
        break
      }
      case 'operator-retroactive': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content: filteredContent(marker),
          author: 'human',
        })
        step = 'operatorCreateThread'
        const result = await transport.operatorCreateThread({
          sourceMessageId: source.id,
          reason: `Discord E2E ${marker}`,
        })
        if (result._tag === 'Created' && isOwnedThread(result.thread, source, target, marker) === true) {
          owned.thread = result.thread
          passed = true
        }
        break
      }
      case 'operator-idempotent': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content: filteredContent(marker),
          author: 'human',
        })
        step = 'operatorCreateThread'
        const first = await transport.operatorCreateThread({
          sourceMessageId: source.id,
          reason: `Discord E2E ${marker}`,
        })
        const second = await transport.operatorCreateThread({
          sourceMessageId: source.id,
          reason: `Discord E2E repeat ${marker}`,
        })
        if (
          first._tag === 'Created' &&
          second._tag === 'AlreadySatisfied' &&
          first.thread.id === second.thread.id &&
          isOwnedThread(first.thread, source, target, marker) === true
        ) {
          owned.thread = first.thread
          passed = true
        }
        break
      }
      case 'operator-concurrent': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content: filteredContent(marker),
          author: 'human',
        })
        step = 'operatorCreateThread'
        const [first, second] = await Promise.all([
          transport.operatorCreateThread({
            sourceMessageId: source.id,
            reason: `Discord E2E concurrent A ${marker}`,
          }),
          transport.operatorCreateThread({
            sourceMessageId: source.id,
            reason: `Discord E2E concurrent B ${marker}`,
          }),
        ])
        const created = [first, second].filter((result) => result._tag === 'Created')
        const satisfied = [first, second].filter((result) => result._tag === 'AlreadySatisfied')
        const thread = first._tag === 'Created' ? first.thread : second._tag === 'Created' ? second.thread : undefined
        const satisfiedThread =
          first._tag === 'AlreadySatisfied'
            ? first.thread
            : second._tag === 'AlreadySatisfied'
              ? second.thread
              : undefined
        if (
          created.length === 1 &&
          satisfied.length === 1 &&
          thread !== undefined &&
          satisfiedThread?.id === thread.id &&
          isOwnedThread(thread, source, target, marker) === true
        ) {
          owned.thread = thread
          passed = true
        }
        break
      }
      case 'message-action-authorized': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content: commandContent(marker),
          author: 'human',
        })
        step = 'invokeMessageAction'
        const result = await transport.invokeMessageAction({
          sourceMessageId: source.id,
          marker,
          persona: 'maintainer',
        })
        const responseOwned = ownResponses([result.response])
        if (
          responseOwned === true &&
          result._tag === 'Created' &&
          isOwnedThread(result.thread, source, target, marker) === true
        ) {
          owned.thread = result.thread
          passed = true
        }
        break
      }
      case 'message-action-denied': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content: commandContent(marker),
          author: 'human',
        })
        step = 'invokeMessageAction'
        const result = await transport.invokeMessageAction({
          sourceMessageId: source.id,
          marker,
          persona: 'member',
        })
        const responseOwned = ownResponses([result.response])
        step = 'findThreadForMessage'
        const candidate = await transport.findThreadForMessage(target.guildId, source.id)
        if (candidate !== undefined && isOwnedThread(candidate, source, target, marker) === true) {
          owned.thread = candidate
        }
        passed = responseOwned === true && result._tag === 'Denied' && candidate === undefined
        break
      }
      case 'docs-public': {
        const channelId = target.docsChannelIds.public
        step = 'invokeDocs'
        const result = await transport.invokeDocs({
          channelId,
          marker,
          query: `${marker} How does syncing work?`,
          location: 'public',
          persona: 'member',
        })
        const responseOwned = ownResponses(result.responses, channelId)
        passed =
          responseOwned === true &&
          result._tag === 'Answered' &&
          result.responses.every((response) => response.hasAnswer === true) &&
          result.responses.some((response) => response.hasSources === true)
        break
      }
      case 'docs-role-restricted': {
        const channelId = target.docsChannelIds.restricted
        step = 'invokeDocs'
        const result = await transport.invokeDocs({
          channelId,
          marker,
          query: `${marker} How does syncing work?`,
          location: 'restricted',
          persona: 'contributor',
        })
        const responseOwned = ownResponses(result.responses, channelId)
        passed =
          responseOwned === true &&
          result._tag === 'Answered' &&
          result.responses.every((response) => response.hasAnswer === true) &&
          result.responses.some((response) => response.hasSources === true)
        break
      }
      case 'docs-denied': {
        const channelId = target.docsChannelIds.restricted
        step = 'invokeDocs'
        const result = await transport.invokeDocs({
          channelId,
          marker,
          query: `${marker} How does syncing work?`,
          location: 'restricted',
          persona: 'member',
        })
        const responseOwned = ownResponses(result.responses, channelId)
        passed = responseOwned === true && result._tag === 'Denied'
        break
      }
    }
  } catch (cause) {
    const failure = scenarioFailure(cause, step)
    const cleanupResult = await cleanup(transport, target, owned)
    const cleanupFailed = (cleanupResult.failures?.length ?? 0) > 0
    if (cause instanceof E2EPrerequisiteUnavailableError && cleanupFailed === false) {
      return {
        ...base,
        verdict: 'UNRUN',
        assertions: 'not-reached',
        reason: 'prerequisite-missing',
        failure,
        artifactHashes: artifactHashes(owned),
        cleanup: cleanupResult,
      }
    }
    return {
      ...base,
      verdict: 'FAIL',
      assertions: 'not-reached',
      reason:
        cause instanceof E2EPrerequisiteUnavailableError && cleanupFailed === true
          ? 'cleanup-failed'
          : 'transport-failed',
      failure,
      artifactHashes: artifactHashes(owned),
      cleanup: cleanupResult,
    }
  }

  const cleanupResult = await cleanup(transport, target, owned)
  const cleanupFailed = (cleanupResult.failures?.length ?? 0) > 0
  return {
    ...base,
    verdict: passed === true && cleanupFailed === false ? 'PASS' : 'FAIL',
    assertions: passed === true ? 'passed' : 'failed',
    reason: passed === false ? 'assertion-failed' : cleanupFailed === true ? 'cleanup-failed' : 'assertions-passed',
    artifactHashes: artifactHashes(owned),
    cleanup: cleanupResult,
  }
}

const artifactHashes = (owned: OwnedArtifacts): ReadonlyArray<string> =>
  [owned.source?.id, owned.thread?.id, ...owned.responses.map((response) => response.id)]
    .filter((value): value is Snowflake => value !== undefined)
    .map(opaqueHash)

export const runE2EMatrix = async (input: {
  readonly environment: 'fake' | 'staging'
  readonly target: StagingTarget
  readonly transport: E2ETransport
  readonly selection?: ScenarioSelection
  readonly allowHumanAssisted?: boolean
}): Promise<RunReceipt> => {
  const runId = makeRunId()
  const startedAt = new Date().toISOString()
  const selectedScenarioIds = new Set(scenarioIdsForSelection(input.selection ?? fullScenarioSelection))
  const targetHash = opaqueHash(`${input.target.guildId}:${input.target.channelId}`)
  let scenarios: ReadonlyArray<ScenarioReceipt>

  const makeEmptyReceipt = (
    scenario: ScenarioDefinition,
    verdict: ScenarioReceipt['verdict'],
    reason: ScenarioReceipt['reason'],
  ): ScenarioReceipt => ({
    scenario: scenario.id,
    executor: scenario.executor,
    verdict,
    assertions: 'not-reached',
    reason,
    targetHash,
    markerHash: opaqueHash(makeMarker(runId, scenario.id)),
    artifactHashes: [],
    cleanup: noCleanup,
  })
  const receiptForUnselected = (scenario: ScenarioDefinition): ScenarioReceipt =>
    makeEmptyReceipt(scenario, 'UNRUN', 'not-selected')

  const targetChannelIds = [
    ...new Set([input.target.channelId, input.target.docsChannelIds.public, input.target.docsChannelIds.restricted]),
  ]
  if (targetChannelIds.some((channelId) => input.target.allowedChannelIds.has(channelId) === false) === true) {
    scenarios = scenarioMatrix.map((scenario) =>
      selectedScenarioIds.has(scenario.id) === true
        ? makeEmptyReceipt(scenario, 'FAIL', 'target-denied')
        : receiptForUnselected(scenario),
    )
  } else {
    try {
      const channels = await Promise.all(targetChannelIds.map(input.transport.inspectChannel))
      const targetMatches = channels.every(
        (channel, index) =>
          channel.id === targetChannelIds[index] &&
          channel.guildId === input.target.guildId &&
          channel.topic?.includes(input.target.requiredTopicSentinel) === true,
      )
      if (targetMatches === false) {
        scenarios = scenarioMatrix.map((scenario) =>
          selectedScenarioIds.has(scenario.id) === true
            ? makeEmptyReceipt(scenario, 'FAIL', 'target-mismatch')
            : receiptForUnselected(scenario),
        )
      } else {
        scenarios = []
        for (const scenario of scenarioMatrix) {
          if (selectedScenarioIds.has(scenario.id) === false) {
            scenarios = [...scenarios, receiptForUnselected(scenario)]
            continue
          }

          const receipt = await runScenario({
            scenario,
            marker: makeMarker(runId, scenario.id),
            transport: input.transport,
            target: input.target,
            expectAiTitles: input.target.expectAiTitles === true,
            allowHumanAssisted: input.allowHumanAssisted === true,
          })
          scenarios = [...scenarios, receipt]
          if (receipt.reason === 'cleanup-failed' || receipt.reason === 'transport-failed') {
            const completed = new Set(scenarios.map((item) => item.scenario))
            scenarios = [
              ...scenarios,
              ...scenarioMatrix
                .filter((item) => !completed.has(item.id))
                .map((item) =>
                  selectedScenarioIds.has(item.id) === true
                    ? makeEmptyReceipt(item, 'UNRUN', 'prerequisite-missing')
                    : receiptForUnselected(item),
                ),
            ]
            break
          }
        }
      }
    } catch {
      scenarios = scenarioMatrix.map((scenario) =>
        selectedScenarioIds.has(scenario.id) === true
          ? makeEmptyReceipt(scenario, 'FAIL', 'transport-failed')
          : receiptForUnselected(scenario),
      )
    }
  }

  return {
    schemaVersion: 2,
    runId,
    environment: input.environment,
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios,
    verdict: aggregateVerdict(scenarios),
  }
}
