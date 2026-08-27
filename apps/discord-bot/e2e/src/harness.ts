import {
  aggregateVerdict,
  fullScenarioSelection,
  makeMarker,
  makeRunId,
  opaqueHash,
  scenarioIdsForSelection,
  scenarioMatrix,
  type ArtifactCleanup,
  type MessageSnapshot,
  type ResponseSnapshot,
  type RunReceipt,
  type ScenarioDefinition,
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
  source: MessageSnapshot,
  target: StagingTarget,
  marker: string,
): boolean =>
  thread.id === source.id &&
  thread.sourceMessageId === source.id &&
  thread.parentChannelId === target.channelId &&
  thread.guildId === target.guildId &&
  thread.marker === marker

const cleanup = async (
  transport: E2ETransport,
  target: StagingTarget,
  owned: OwnedArtifacts,
): Promise<ArtifactCleanup> => {
  const result: {
    sourceMessage: ArtifactCleanup['sourceMessage']
    thread: ArtifactCleanup['thread']
    response: ArtifactCleanup['response']
  } = {
    sourceMessage: 'not-needed',
    thread: 'not-needed',
    response: 'not-needed',
  }

  if (owned.responses.length > 0) {
    const outcomes = await Promise.allSettled(
      owned.responses.map((response) => transport.deleteResponse(response.channelId, response.id)),
    )
    result.response = outcomes.some((outcome) => outcome.status === 'rejected') === true ? 'failed' : 'deleted'
  }
  if (owned.thread !== undefined && owned.source !== undefined) {
    try {
      await transport.deleteThread(owned.thread.id)
      result.thread = 'deleted'
    } catch {
      result.thread = 'failed'
    }
  }
  if (owned.source !== undefined) {
    try {
      await transport.deleteMessage(target.channelId, owned.source.id)
      result.sourceMessage = 'deleted'
    } catch {
      result.sourceMessage = 'failed'
    }
  }
  return result
}

const runScenario = async (input: {
  readonly scenario: ScenarioDefinition
  readonly marker: string
  readonly transport: E2ETransport
  readonly target: StagingTarget
  readonly allowHumanAssisted: boolean
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
      reason: 'official-automation-unavailable',
      artifactHashes: [],
      cleanup: noCleanup,
    }
  }

  const owned: OwnedArtifacts = { source: undefined, thread: undefined, responses: [] }
  const createOwnedMessage = async (
    request: Parameters<E2ETransport['createMessage']>[0],
  ): Promise<MessageSnapshot> => {
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
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          content: `${marker} How does LiveStore sync between clients?`,
          author: 'human',
        })
        const candidate = await pollForThread(transport, target, source.id)
        if (candidate !== undefined && isOwnedThread(candidate, source, target, marker) === true) {
          owned.thread = candidate
          passed = true
        }
        break
      }
      case 'automatic-filtered': {
        const source = await createOwnedMessage({
          channelId: target.channelId,
          marker,
          // Keep this exact low-information payload: adding the marker to the
          // visible content would intentionally make it policy-eligible.
          content: 'thanks',
          author: 'human',
        })
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
          content: 'thanks',
          author: 'human',
        })
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
          content: 'thanks',
          author: 'human',
        })
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
          content: 'thanks',
          author: 'human',
        })
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
          content: 'thanks',
          author: 'human',
        })
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
          content: 'thanks',
          author: 'human',
        })
        const result = await transport.invokeMessageAction({
          sourceMessageId: source.id,
          marker,
          persona: 'member',
        })
        const responseOwned = ownResponses([result.response])
        const candidate = await transport.findThreadForMessage(target.guildId, source.id)
        if (candidate !== undefined && isOwnedThread(candidate, source, target, marker) === true) {
          owned.thread = candidate
        }
        passed = responseOwned === true && result._tag === 'Denied' && candidate === undefined
        break
      }
      case 'docs-public': {
        const channelId = target.docsChannelIds.public
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
    const cleanupResult = await cleanup(transport, target, owned)
    if (cause instanceof E2EPrerequisiteUnavailableError && Object.values(cleanupResult).includes('failed') === false) {
      return {
        ...base,
        verdict: 'UNRUN',
        reason: 'prerequisite-missing',
        artifactHashes: artifactHashes(owned),
        cleanup: cleanupResult,
      }
    }
    return {
      ...base,
      verdict: 'FAIL',
      reason: Object.values(cleanupResult).includes('failed') === true ? 'cleanup-failed' : 'transport-failed',
      artifactHashes: artifactHashes(owned),
      cleanup: cleanupResult,
    }
  }

  const cleanupResult = await cleanup(transport, target, owned)
  const cleanupFailed = Object.values(cleanupResult).includes('failed')
  return {
    ...base,
    verdict: passed === true && cleanupFailed === false ? 'PASS' : 'FAIL',
    reason: cleanupFailed === true ? 'cleanup-failed' : passed === true ? 'assertions-passed' : 'assertion-failed',
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
    schemaVersion: 1,
    runId,
    environment: input.environment,
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios,
    verdict: aggregateVerdict(scenarios),
  }
}
