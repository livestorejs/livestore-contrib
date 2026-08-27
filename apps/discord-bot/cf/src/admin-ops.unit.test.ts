import { describe, expect, it } from 'vitest'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  commandsSyncOutcome,
  controlResultFromThreadOutcome,
  makeCommandsSyncOperation,
  makeOperatorThreadCreate,
  makeRuntimeConfigAdminOperations,
  OperatorThreadCreatePayload,
  type AdminOperationOutcome,
} from './admin-ops.ts'
import type { ThreadObservation } from '../../src/reconciliation/model.ts'
import { ControlResult } from '../../src/control/schema.ts'
import type { ThreadObservationPort } from '../../src/reconciliation/port.ts'
import { OperatorSourceReadError } from '../../src/runtime/threading-adapter.ts'
import { DiscordSnowflake } from '../../src/threading/model.ts'
import type { OperatorSourceFacts, OperatorSourceReader } from '../../src/runtime/threading-adapter.ts'
import type { ThreadCandidate, ThreadOutcome } from '../../src/threading/model.ts'
import { makeFakeDoStorage } from './fake-do-storage.ts'
import { makeRuntimeConfigStore, type RuntimeConfigDocument } from './runtime-config.ts'

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

describe('revisioned runtime config control', () => {
  it('GET reads durable config without building an unavailable runtime', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage(), 'test-release')
    let buildCount = 0
    const operations = makeRuntimeConfigAdminOperations({
      store,
      getRunning: () => undefined,
      buildCandidate: (_document) =>
        Effect.sync(() => {
          buildCount += 1
          return 'candidate'
        }),
      activateCandidate: (_candidate) => Effect.void,
    })

    const result = await Effect.runPromise(operations.configGet)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      _tag: 'Success',
      stored: { revision: 0 },
      running: null,
      diverged: true,
    })
    expect(buildCount).toBe(0)
  })

  it('reports stored/running revisions separately and rejects a stale PUT', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage(), 'test-release')
    const running = await Effect.runPromise(store.read)
    const operations = makeRuntimeConfigAdminOperations({
      store,
      getRunning: () => running,
      buildCandidate: (document) => Effect.succeed(document),
      activateCandidate: (_candidate) => Effect.void,
    })

    const persisted = await Effect.runPromise(
      operations.configPut({ expectedRevision: 0, config: running.config, reload: false }),
    )
    expect(persisted).toMatchObject({
      ok: true,
      body: { _tag: 'Planned', revision: 1, applied: false },
    })
    const status = await Effect.runPromise(operations.configGet)
    expect(status.body).toMatchObject({
      stored: { revision: 1 },
      running: { revision: 0 },
      diverged: true,
    })

    const stale = await Effect.runPromise(
      operations.configPut({ expectedRevision: 0, config: running.config, reload: false }),
    )
    expect(stale).toMatchObject({
      ok: false,
      status: 409,
      body: { _tag: 'InvalidControlInput', message: expect.stringContaining('Stale') },
    })
    expect((await Effect.runPromise(store.read)).revision).toBe(1)
  })

  it('a bad identity candidate preserves stored/running config and remains repairable', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage(), 'test-release')
    let running: RuntimeConfigDocument | undefined = await Effect.runPromise(store.read)
    const initial = running
    const operations = makeRuntimeConfigAdminOperations({
      store,
      getRunning: () => running,
      buildCandidate: (document) =>
        document.config.applicationId === '9999999999999999999'
          ? Effect.fail('Discord application identity mismatch')
          : Effect.succeed(document),
      activateCandidate: (candidate) =>
        Effect.sync(() => {
          running = candidate
        }),
    })
    const badConfig = {
      ...structuredClone(initial.config),
      applicationId: '9999999999999999999',
      commandScope: {
        ...initial.config.commandScope,
        applicationId: '9999999999999999999',
      },
    }

    const rejected = await Effect.runPromise(
      operations.configPut({ expectedRevision: 0, config: badConfig, reload: true }),
    )
    expect(rejected).toMatchObject({
      ok: false,
      status: 409,
      body: { _tag: 'ControlApplicationFailure' },
    })
    expect(await Effect.runPromise(store.read)).toEqual(initial)
    expect(running).toEqual(initial)

    const repaired = await Effect.runPromise(
      operations.configPut({ expectedRevision: 0, config: initial.config, reload: true }),
    )
    expect(repaired).toMatchObject({
      ok: true,
      body: { _tag: 'Success', revision: 1, applied: true },
    })
    expect(running?.revision).toBe(1)
  })
  it('reports persisted-but-not-activated while keeping the prior runtime live and repairable', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage(), 'test-release')
    let running = await Effect.runPromise(store.read)
    let activationFails = true
    const operations = makeRuntimeConfigAdminOperations({
      store,
      getRunning: () => running,
      buildCandidate: (document) => Effect.succeed(document),
      // Models one durable telemetry activation defect. The serialized runtime
      // helper activates before stopping/publishing, so the prior owner stays live.
      activateCandidate: (candidate) =>
        activationFails === true ? Effect.die('telemetry activation failed') : Effect.sync(() => { running = candidate }),
    })

    const failed = await Effect.runPromise(
      operations.configPut({ expectedRevision: 0, config: running.config, reload: true }),
    )
    expect(failed).toMatchObject({
      ok: false,
      status: 502,
      body: {
        _tag: 'ControlAmbiguousOutcome',
        state: 'persisted-but-not-activated',
        storedRevision: 1,
        runningRevision: 0,
        diverged: true,
      },
    })
    expect((await Effect.runPromise(store.read)).revision).toBe(1)
    const repairStatus = await Effect.runPromise(operations.configGet)
    expect(repairStatus).toMatchObject({
      ok: true,
      body: { stored: { revision: 1 }, running: { revision: 0 }, diverged: true },
    })
    activationFails = false
    const repaired = await Effect.runPromise(
      operations.configPut({ expectedRevision: 1, config: running.config, reload: true }),
    )
    expect(repaired).toMatchObject({
      ok: true,
      body: { _tag: 'Success', revision: 2, applied: true },
    })
    expect(running.revision).toBe(2)
  })

})

describe('guarded command sync', () => {
  const requestFor = (document: RuntimeConfigDocument, apply: boolean) => ({
    environment: document.config.environment,
    reason: 'operator requested command reconciliation',
    apply,
    expectedApplicationId: document.config.applicationId,
    expectedGuildId: document.config.guildId,
  })

  it('plans without invoking the mutating synchronizer', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage())
    const running = await Effect.runPromise(store.read)
    let applyCount = 0
    const operation = makeCommandsSyncOperation({
      running,
      readStored: store.read,
      plan: (_scope) =>
        Effect.succeed({ created: ['1:docs'], updated: [], deleted: [], unchanged: 1 }),
      apply: (_scope) =>
        Effect.sync(() => {
          applyCount += 1
          return { created: [], updated: [], deleted: [], unchanged: 2 }
        }),
    })

    const result = await Effect.runPromise(operation(requestFor(running, false)))
    expect(result).toMatchObject({
      ok: true,
      body: {
        _tag: 'Planned',
        commandSync: { reason: 'operator requested command reconciliation', apply: false },
      },
    })
    expect(Schema.is(ControlResult)(result.body)).toBe(true)
    expect(applyCount).toBe(0)
  })

  it('applies against the running config command scope and returns a decodable result', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage())
    const running = await Effect.runPromise(store.read)
    let appliedScope: RuntimeConfigDocument['config']['commandScope'] | undefined
    const operation = makeCommandsSyncOperation({
      running,
      readStored: store.read,
      plan: (_scope) => Effect.succeed({ created: [], updated: [], deleted: [], unchanged: 2 }),
      apply: (scope) =>
        Effect.sync(() => {
          appliedScope = scope
          return { created: ['1:docs'], updated: [], deleted: [], unchanged: 1 }
        }),
    })

    const result = await Effect.runPromise(operation(requestFor(running, true)))
    expect(appliedScope).toEqual(running.config.commandScope)
    expect(result.body).toMatchObject({
      _tag: 'Success',
      commandSync: { environment: 'staging', apply: true },
    })
    expect(Schema.is(ControlResult)(result.body)).toBe(true)
  })

  it('rejects an apply fingerprint mismatch before REST mutation', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage())
    const running = await Effect.runPromise(store.read)
    let applyCount = 0
    const operation = makeCommandsSyncOperation({
      running,
      readStored: store.read,
      plan: (_scope) => Effect.succeed({ created: [], updated: [], deleted: [], unchanged: 2 }),
      apply: (_scope) =>
        Effect.sync(() => {
          applyCount += 1
          return { created: [], updated: [], deleted: [], unchanged: 2 }
        }),
    })

    const result = await Effect.runPromise(
      operation({ ...requestFor(running, true), expectedApplicationId: '9999999999999999999' }),
    )
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { _tag: 'InvalidControlInput' },
    })
    expect(applyCount).toBe(0)
  })

  it('rejects stored/running divergence before REST mutation', async () => {
    const store = makeRuntimeConfigStore(makeFakeDoStorage())
    const running = await Effect.runPromise(store.read)
    await Effect.runPromise(store.write({ expectedRevision: 0, config: running.config }))
    let applyCount = 0
    const operation = makeCommandsSyncOperation({
      running,
      readStored: store.read,
      plan: (_scope) => Effect.succeed({ created: [], updated: [], deleted: [], unchanged: 2 }),
      apply: (_scope) =>
        Effect.sync(() => {
          applyCount += 1
          return { created: [], updated: [], deleted: [], unchanged: 2 }
        }),
    })

    const result = await Effect.runPromise(operation(requestFor(running, true)))
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { _tag: 'InvalidControlInput', message: expect.stringContaining('diverges') },
    })
    expect(applyCount).toBe(0)
  })
})
