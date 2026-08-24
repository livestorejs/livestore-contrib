import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import { DiscordSnowflake, ThreadCandidate, type SourceChannelKind, type ThreadClaimHandle } from './model.ts'
import {
  makeThreadWorkflow,
  ThreadMutationError,
  type ReconciliationDecision,
  type ThreadWorkflowPorts,
} from './workflow.ts'

const candidate = Schema.decodeUnknownSync(ThreadCandidate)({
  environment: 'staging',
  source: {
    guildId: '10000000000000001',
    channelId: '10000000000000002',
    messageId: '10000000000000003',
  },
  sourceChannelKind: 'GuildText',
  messageKind: 'Default',
  hasMessageReference: false,
  authorKind: 'Human',
  content: 'Sync bug?',
  attachmentCount: 0,
  hasPoll: false,
  stickerCount: 0,
  trigger: { _tag: 'Automatic', deliveryCorrelation: 'session:1' },
})
const threadId = Schema.decodeUnknownSync(DiscordSnowflake)('10000000000000004')
const actorId = Schema.decodeUnknownSync(DiscordSnowflake)('10000000000000005')
const claimHandle: ThreadClaimHandle = {
  sourceMessageId: candidate.source.messageId,
  claimToken: '00000000-0000-4000-8000-000000000001',
}

const config = {
  policy: {
    environment: 'staging',
    guildId: candidate.source.guildId,
    parentChannelIds: new Set([candidate.source.channelId]),
    admittedParentKinds: new Set<SourceChannelKind>(['GuildText', 'GuildAnnouncement']),
    legacyCommands: new Set(['!help']),
  },
  title: { aiTitleChannelIds: new Set<string>() },
}

const makePorts = (
  events: Array<string>,
  decision: ReconciliationDecision = { _tag: 'Proceed', handle: claimHandle },
): ThreadWorkflowPorts => ({
  reconciliation: {
    prepare: () =>
      Effect.sync(() => {
        events.push('prepare')
        return decision
      }),
    markCreating: (handle) =>
      Effect.sync(() => {
        events.push(`creating:${handle.sourceMessageId}:${handle.claimToken}`)
      }),
    markCreated: (handle) =>
      Effect.sync(() => {
        events.push(`created:${handle.sourceMessageId}:${handle.claimToken}`)
      }),
    markUnknownExternal: (handle) =>
      Effect.sync(() => {
        events.push(`unknown_external:${handle.sourceMessageId}:${handle.claimToken}`)
      }),
    markFailed: (handle) =>
      Effect.sync(() => {
        events.push(`failed:${handle.sourceMessageId}:${handle.claimToken}`)
      }),
  },
  mutation: {
    create: ({ name }) =>
      Effect.sync(() => {
        events.push(`mutate:${name}`)
        return threadId
      }),
  },
  title: { propose: () => Effect.succeed('unused') },
})

describe('thread workflow', () => {
  it.effect('commits creating before one mutation and records the result', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const outcome = yield* makeThreadWorkflow(makePorts(events), config)(candidate)
      expect(outcome).toEqual({ _tag: 'Created', source: candidate.source, threadId })
      expect(events).toEqual([
        'prepare',
        `creating:${claimHandle.sourceMessageId}:${claimHandle.claimToken}`,
        `mutate:${candidate.content}`,
        `created:${claimHandle.sourceMessageId}:${claimHandle.claimToken}`,
      ])
    }),
  )

  it.effect('rejects automatic low-information content before any effect', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const outcome = yield* makeThreadWorkflow(makePorts(events), config)({ ...candidate, content: 'hello' })
      expect(outcome).toEqual({ _tag: 'PolicyRejected', source: candidate.source, reason: 'greeting' })
      expect(events).toEqual([])
    }),
  )

  it.effect('lets an authorized intentional trigger select a reply', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const outcome = yield* makeThreadWorkflow(
        makePorts(events),
        config,
      )({
        ...candidate,
        messageKind: 'Reply',
        hasMessageReference: true,
        trigger: {
          _tag: 'DiscordManual',
          actorId,
          authorized: true,
          deliveryCorrelation: 'interaction-1',
        },
      })
      expect(outcome._tag).toBe('Created')
      expect(events).toContain(`creating:${claimHandle.sourceMessageId}:${claimHandle.claimToken}`)
    }),
  )

  it.effect('fails closed on intentional-trigger authorization', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const outcome = yield* makeThreadWorkflow(
        makePorts(events),
        config,
      )({
        ...candidate,
        trigger: {
          _tag: 'DiscordManual',
          actorId,
          authorized: false,
          deliveryCorrelation: 'interaction-1',
        },
      })
      expect(outcome._tag).toBe('AuthorizationRejected')
      expect(events).toEqual([])
    }),
  )

  it.effect('returns an existing thread without naming or mutation', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const outcome = yield* makeThreadWorkflow(
        makePorts(events, { _tag: 'AlreadySatisfied', threadId }),
        config,
      )(candidate)
      expect(outcome).toEqual({ _tag: 'AlreadySatisfied', source: candidate.source, threadId })
      expect(events).toEqual(['prepare'])
    }),
  )

  it.effect('accepts transport metadata for an existing thread as already satisfied', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const outcome = yield* makeThreadWorkflow(
        makePorts(events),
        config,
      )({
        ...candidate,
        existingThreadId: threadId,
      })
      expect(outcome).toEqual({ _tag: 'AlreadySatisfied', source: candidate.source, threadId })
      expect(events).toEqual([])
    }),
  )

  it.effect('never mutates an unresolved ambiguous claim', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const outcome = yield* makeThreadWorkflow(makePorts(events, { _tag: 'Ambiguous' }), config)(candidate)
      expect(outcome).toEqual({
        _tag: 'TransientFailure',
        source: candidate.source,
        failureCode: 'external_outcome_unknown',
      })
      expect(events).toEqual(['prepare'])
    }),
  )

  it.effect('fails safely when reconciliation returns a handle for another source', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const wrongSource = yield* Schema.decodeUnknownEffect(DiscordSnowflake)('10000000000000009')
      const outcome = yield* makeThreadWorkflow(
        makePorts(events, {
          _tag: 'Proceed',
          handle: { ...claimHandle, sourceMessageId: wrongSource },
        }),
        config,
      )(candidate)
      expect(outcome).toEqual({
        _tag: 'TerminalFailure',
        source: candidate.source,
        failureCode: 'claim_source_mismatch',
      })
      expect(events).toEqual(['prepare'])
    }),
  )

  it.effect('records an uncertain submitted effect as unknown_external', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const ports = makePorts(events)
      const outcome = yield* makeThreadWorkflow(
        {
          ...ports,
          mutation: {
            create: () => new ThreadMutationError({ kind: 'ambiguous', code: 'rest_timeout', message: 'timed out' }),
          },
        },
        config,
      )(candidate)
      expect(outcome).toEqual({ _tag: 'TransientFailure', source: candidate.source, failureCode: 'rest_timeout' })
      expect(events).toEqual([
        'prepare',
        `creating:${claimHandle.sourceMessageId}:${claimHandle.claimToken}`,
        `unknown_external:${claimHandle.sourceMessageId}:${claimHandle.claimToken}`,
      ])
    }),
  )
})
