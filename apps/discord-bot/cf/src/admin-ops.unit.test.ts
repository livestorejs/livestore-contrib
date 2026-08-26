import { describe, expect, it } from 'vitest'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  commandsSyncOutcome,
  controlResultFromThreadOutcome,
  makeOperatorThreadCreate,
  OperatorThreadCreatePayload,
  type AdminOperationOutcome,
} from './admin-ops.ts'
import type { ThreadObservation } from '../../src/reconciliation/model.ts'
import type { ThreadObservationPort } from '../../src/reconciliation/port.ts'
import { OperatorSourceReadError } from '../../src/runtime/threading-adapter.ts'
import { DiscordSnowflake } from '../../src/threading/model.ts'
import type { OperatorSourceFacts, OperatorSourceReader } from '../../src/runtime/threading-adapter.ts'
import type { ThreadCandidate, ThreadOutcome } from '../../src/threading/model.ts'

// Branded snowflakes: the workflow layer's types are schema-branded, so the
// fixtures decode through the same schemas production uses.
const source = Schema.decodeUnknownSync(Schema.Struct({
  guildId: DiscordSnowflake,
  channelId: DiscordSnowflake,
  messageId: DiscordSnowflake,
}))({
  guildId: '1154415661842452532',
  channelId: '1373597443798859776',
  messageId: '3456789012345678901',
})

const threadId = (value: string) => Schema.decodeUnknownSync(DiscordSnowflake)(value)

const facts: OperatorSourceFacts = {
  messageKind: 'Default',
  hasMessageReference: false,
  authorKind: 'Human',
  content: 'hello',
  attachmentCount: 0,
  hasPoll: false,
  stickerCount: 0,
}

const config = {
  environment: 'staging' as const,
  guildId: source.guildId,
  actionChannelIds: [source.channelId],
}

const okReader: OperatorSourceReader = { read: () => Effect.succeed(facts) }
const okObserver: ThreadObservationPort = {
  observeSourceThread: () => Effect.succeed({ _tag: 'Absent' }) as Effect.Effect<ThreadObservation>,
}

describe('controlResultFromThreadOutcome', () => {
  it.each([
    [{ _tag: 'Created', source, threadId: threadId('9990000000000000099') }, 'Success'],
    [{ _tag: 'AlreadySatisfied', source, threadId: threadId('9990000000000000099') }, 'AlreadySatisfied'],
    [{ _tag: 'AuthorizationRejected', source }, 'ControlApplicationFailure'],
    [{ _tag: 'PolicyRejected', source, reason: 'not_eligible' }, 'ControlApplicationFailure'],
    [{ _tag: 'TerminalFailure', source, failureCode: 'discord_definitive_failure' }, 'ControlApplicationFailure'],
    [
      { _tag: 'TransientFailure', source, failureCode: 'discord_create_outcome_unknown' },
      'ControlAmbiguousOutcome',
    ],
  ] as ReadonlyArray<readonly [ThreadOutcome, string]>)(
    'maps %j to a decodable outcome tagged %s',
    (outcome, expectedTag) => {
      const result = controlResultFromThreadOutcome(outcome)
      expect(result.body).toMatchObject({ _tag: expectedTag })
      if (expectedTag === 'Success' || expectedTag === 'AlreadySatisfied') {
        expect(result.ok).toBe(true)
        expect(result.status).toBe(200)
        expect(result.body.correlationId).toBe(source.messageId)
      } else {
        expect(result.ok).toBe(false)
      }
    },
  )

  it('keeps transient failures ambiguous (Discord may have committed)', () => {
    const result = controlResultFromThreadOutcome({
      _tag: 'TransientFailure',
      source,
      failureCode: 'external_outcome_unknown',
    })
    expect(result.status).toBe(502)
    expect(result.body._tag).toBe('ControlAmbiguousOutcome')
  })
})

describe('makeOperatorThreadCreate', () => {
  const buildDeps = (overrides: Partial<Parameters<typeof makeOperatorThreadCreate>[0]> = {}) =>
    ({
      config,
      sourceReader: okReader,
      sourceObserver: okObserver,
      thread: (_candidate: ThreadCandidate) =>
        Effect.succeed({ _tag: 'Created', source, threadId: threadId('4200000000000000042') }) as Effect.Effect<ThreadOutcome>,
      ...overrides,
    }) satisfies Parameters<typeof makeOperatorThreadCreate>[0]

  it('runs the real workflow on an admitted source and reports Success with correlation id', async () => {
    const candidates: Array<ThreadCandidate> = []
    const create = makeOperatorThreadCreate(buildDeps({
      thread: (candidate) => {
        candidates.push(candidate)
        return Effect.succeed({
          _tag: 'Created',
          source: candidate.source,
          threadId: threadId('4200000000000000042'),
        })
      },
    }))
    const result = await Effect.runPromise(
      create({ source, environment: 'staging', apply: true, reason: 'operator asked' }),
    )
    expect(result.ok).toBe(true)
    expect(result.body).toMatchObject({ _tag: 'Success', correlationId: source.messageId })
    // The operator trigger carries principal + reason into the candidate.
    const candidate = candidates[0]
    expect(candidate?.trigger._tag).toBe('Operator')
  })

  it('rejects environment mismatch without touching Discord or the journal', async () => {
    let reads = 0
    const create = makeOperatorThreadCreate(buildDeps({
      sourceReader: {
        read: () =>
          Effect.sync(() => {
            reads += 1
            return facts
          }),
      },
    }))
    const result = await Effect.runPromise(
      create({ source, environment: 'production', apply: true, reason: 'why' }),
    )
    expect(result.ok).toBe(false)
    expect(result.body).toMatchObject({ _tag: 'ControlApplicationFailure' })
    expect(reads).toBe(0)
  })

  it('rejects sources outside the configured guild/channel scope', async () => {
    const create = makeOperatorThreadCreate(buildDeps())
    const result = await Effect.runPromise(
      create({
        source: { guildId: source.guildId, channelId: threadId('9999999999999999999'), messageId: source.messageId },
        environment: 'staging',
        apply: true,
        reason: 'why',
      }),
    )
    expect(result.body).toMatchObject({ _tag: 'ControlApplicationFailure' })
  })

  it('surfaces an unavailable source read as ControlDependencyUnavailable', async () => {
    const create = makeOperatorThreadCreate(buildDeps({
      sourceReader: {
        read: () =>
          Effect.fail(
            new OperatorSourceReadError({
              kind: 'unavailable',
              message: 'Discord source message could not be read',
            }),
          ),
      },
    }))
    const result = await Effect.runPromise(
      create({ source, environment: 'staging', apply: true, reason: 'why' }),
    )
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ _tag: 'ControlDependencyUnavailable', dependency: 'discord-source-read' })
  })

  it('maps an Unrun thread observation to a dependency-unavailable outcome (no blind create)', async () => {
    const create = makeOperatorThreadCreate(buildDeps({
      sourceObserver: {
        observeSourceThread: () => Effect.succeed({ _tag: 'Unrun', reason: 'discord_read_unavailable' }),
      },
    }))
    const result = await Effect.runPromise(
      create({ source, environment: 'staging', apply: true, reason: 'why' }),
    )
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ _tag: 'ControlDependencyUnavailable', dependency: 'discord-thread-observation' })
  })

  it('reuses an exactly-anchored source thread as AlreadySatisfied via existingThreadId', async () => {
    const create = makeOperatorThreadCreate(buildDeps({
      sourceObserver: {
        observeSourceThread: () =>
          Effect.succeed({
            _tag: 'ExactSourceThread',
            threadId: threadId('5550000000000000055'),
          }) as Effect.Effect<ThreadObservation>,
      },
      thread: (candidate) => {
        expect(candidate.existingThreadId).toBe(threadId('5550000000000000055'))
        return Effect.succeed({
          _tag: 'AlreadySatisfied',
          source: candidate.source,
          threadId: threadId('5550000000000000055'),
        })
      },
    }))
    const result = await Effect.runPromise(
      create({ source, environment: 'staging', apply: true, reason: 'why' }),
    )
    expect(result.body).toMatchObject({ _tag: 'AlreadySatisfied' })
  })
})

describe('payload schema parity with the CLI', () => {
  it('decodes the exact shape the CLI encodes for ThreadCreate (incl. optional --name)', () => {
    const decoded = Schema.decodeUnknownSync(OperatorThreadCreatePayload)({
      source,
      environment: 'staging',
      apply: true,
      reason: 'operator asked',
      name: 'Incident review',
    })
    expect(decoded.apply).toBe(true)
    expect(decoded.name).toBe('Incident review')
    // And without a requested title:
    const bare = Schema.decodeUnknownSync(OperatorThreadCreatePayload)({
      source,
      environment: 'staging',
      apply: true,
      reason: 'operator asked',
    })
    expect(bare.name).toBeUndefined()
  })

  it('threads an operator-requested title into the thread candidate', async () => {
    let requestedTitle: string | undefined
    const create = makeOperatorThreadCreate({
      config,
      sourceReader: okReader,
      sourceObserver: okObserver,
      thread: (candidate) =>
        Effect.sync(() => {
          requestedTitle = candidate.trigger._tag === 'Operator' ? candidate.trigger.requestedTitle : undefined
          return { _tag: 'Created', source, threadId: threadId('4200000000000000042') }
        }),
    })
    await Effect.runPromise(
      create({ source, environment: 'staging', apply: true, reason: 'why', name: 'My title' }),
    )
    expect(requestedTitle).toBe('My title')
  })
})

it('commandsSyncOutcome reports changed vs already-satisfied like the CLI', () => {
  const changed = commandsSyncOutcome({ created: ['docs'], updated: [], deleted: [], unchanged: 1 })
  expect(changed.body).toMatchObject({ _tag: 'Success', summary: expect.stringContaining('create=1') })

  const unchanged = commandsSyncOutcome({ created: [], updated: [], deleted: [], unchanged: 2 })
  expect(unchanged.body).toMatchObject({ _tag: 'AlreadySatisfied' })
})
