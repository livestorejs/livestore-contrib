import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildCreateMessageSteps,
  buildDocsCommandSteps,
  buildMessageActionSteps,
  CaptureGestureFailure,
  classifyReplies,
  newAppReplies,
  parseMessageRows,
  runReadStepAcrossDocumentReplacement,
  settledAppReplies,
} from './attended-broker-driver.ts'
import { makeRecoveryTransport } from './attended-broker-recovery.ts'
import {
  dispatchBrokerOperation,
  parseBrokerInvocation,
  readBrokerApplicationId,
  type AttendedBrokerDeps,
  type BrokerLedgerInput,
  type BrokerOperation,
  type BrokerMessageIntent,
  type GestureEvidence,
} from './attended-broker.ts'
import { openCleanupLedger, readUnresolvedEntries, recoverCleanupLedger } from './cleanup-ledger.ts'
import { makeFakeWorld } from './fake-transport.ts'
import { runE2EMatrix } from './harness.ts'
import { topicSentinel, type ScenarioId, type Snowflake } from './model.ts'

const guildId = '111111111111111111' as Snowflake
const channelId = '222222222222222222' as Snowflake

const baseRequest = { guildId, channelId }

const makeInvocation = (operation: BrokerOperation, request: object, ledgerPath?: string) => ({
  operation,
  request,
  ledgerPath,
  runId: ledgerPath === undefined ? undefined : 'test-run',
})

const makeDeps = (input: {
  readonly evidence: GestureEvidence
  readonly waitForMessage?: () => Promise<{ id: Snowflake; channelId: Snowflake; marker: string; author: 'human' }>
  readonly waitForThread?: () => Promise<Snowflake | undefined>
  readonly snapshotPublicResponseIds?: () => Promise<ReadonlyArray<Snowflake>>
  readonly waitForPublicResponses?: () => Promise<ReadonlyArray<Snowflake>>
  readonly recordOrder: string[]
}): AttendedBrokerDeps => ({
  driver: { perform: async () => input.evidence },
  correlator: {
    waitForMessage:
      input.waitForMessage ??
      (() => {
        throw new Error('not expected')
      }),
    waitForThread:
      input.waitForThread ??
      (() => {
        throw new Error('not expected')
      }),
    snapshotPublicResponseIds: input.snapshotPublicResponseIds ?? (async () => []),
    waitForPublicResponses:
      input.waitForPublicResponses ??
      (async () => {
        throw new Error('not expected')
      }),
    dispose: async () => undefined,
  },
  performer: 'official-client-session',
  openLedger: () => ({
    record: (entry: BrokerLedgerInput) => input.recordOrder.push(`record:${entry.kind}:${entry.messageId}`),
    recordMessageIntent: (entry: BrokerMessageIntent) => input.recordOrder.push(`intent:${entry.marker}`),
    resolveMessageIntent: (entry: BrokerMessageIntent) => input.recordOrder.push(`resolve-intent:${entry.marker}`),
    resolve: (entry: BrokerLedgerInput) => input.recordOrder.push(`resolve:${entry.kind}:${entry.messageId}`),
    close: () => input.recordOrder.push('close'),
  }),
})

describe('broker invocation parsing', () => {
  it('parses operation, request json, and optional ledger', () => {
    const parsed = parseBrokerInvocation([
      'create-message',
      '--request-json',
      JSON.stringify(baseRequest),
      '--run-id',
      'run-1',
      '--ledger',
      '/tmp/ledger.jsonl',
    ])
    expect(parsed).toEqual({
      _tag: 'Parsed',
      value: { operation: 'create-message', request: baseRequest, ledgerPath: '/tmp/ledger.jsonl', runId: 'run-1' },
    })
  })

  it('accepts only a declared snowflake application identity for public reply correlation', () => {
    expect(readBrokerApplicationId({ applicationId: '444444444444444444' })).toBe('444444444444444444')
    expect(() => readBrokerApplicationId({})).toThrow(/missing applicationId/)
    expect(() => readBrokerApplicationId({ applicationId: 'not-an-id' })).toThrow(/invalid snowflake/)
  })

  it('requires the run id when a ledger is configured', () => {
    expect(parseBrokerInvocation(['create-message', '--request-json', '{}', '--ledger', '/tmp/l.jsonl'])._tag).toBe(
      'UsageError',
    )
    const parsed = parseBrokerInvocation([
      'create-message',
      '--request-json',
      JSON.stringify(baseRequest),
      '--run-id',
      'run-1',
      '--ledger',
      '/tmp/l.jsonl',
    ])
    expect(parsed._tag).toBe('Parsed')
  })

  it.each([
    ['unknown operation', ['bogus-op', '--request-json', '{}']],
    ['missing request json', ['create-message']],
    ['invalid request json', ['create-message', '--request-json', '{nope']],
    ['duplicate request json', ['create-message', '--request-json', '{}', '--request-json', '{}']],
  ])('rejects %s with a usage error', (_label, args) => {
    expect(parseBrokerInvocation(args)._tag).toBe('UsageError')
  })
})

describe('broker dispatch', () => {
  it('correlates a created message, records it before acknowledging, and attests performer', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({
      evidence: {},
      waitForMessage: async () => ({ id: '333333333333333333' as Snowflake, channelId, marker: 'm', author: 'human' }),
      recordOrder,
    })
    const result = await dispatchBrokerOperation(
      makeInvocation(
        'create-message',
        { ...baseRequest, marker: 'm', content: 'hello m' },
        '/tmp/broker-test-ledger.jsonl',
      ),
      deps,
    )
    expect(result.declineExitCode).toBeUndefined()
    expect(result.payload).toMatchObject({ id: '333333333333333333', performedBy: 'official-client-session' })
    expect(recordOrder).toEqual(['intent:m', 'record:message:333333333333333333', 'resolve-intent:m', 'close'])
  })

  it('maps an operator decline to exit code 7 and resolves its unsent intent', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({ evidence: { declined: true }, recordOrder })
    const result = await dispatchBrokerOperation(
      makeInvocation(
        'create-message',
        { ...baseRequest, marker: 'm', content: 'hello m' },
        '/tmp/broker-test-ledger.jsonl',
      ),
      deps,
    )
    expect(result.declineExitCode).toBe(7)
    expect(recordOrder).toEqual(['intent:m', 'resolve-intent:m', 'close'])
  })

  it('records thread and response artifacts for a created message action', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({
      evidence: { messageActionOutcome: 'created', responseMessageIds: ['444444444444444444'] },
      waitForThread: async () => '555555555555555555' as Snowflake,
      recordOrder,
    })
    const result = await dispatchBrokerOperation(
      makeInvocation(
        'invoke-message-action',
        { ...baseRequest, marker: 'm', sourceMessageId: '666666666666666666' },
        '/tmp/broker-test-ledger.jsonl',
      ),
      deps,
    )
    expect(result.payload).toMatchObject({ _tag: 'Created', thread: { id: '555555555555555555' } })
    expect(recordOrder).toEqual(['record:thread:555555555555555555', 'record:response:444444444444444444', 'close'])
  })

  it('keeps ephemeral responses ID-free while journaling the created thread', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({
      evidence: { messageActionOutcome: 'created', ephemeralResponseCount: 1 },
      waitForThread: async () => '555555555555555555' as Snowflake,
      recordOrder,
    })
    const result = await dispatchBrokerOperation(
      makeInvocation(
        'invoke-message-action',
        { ...baseRequest, marker: 'm', sourceMessageId: '666666666666666666' },
        '/tmp/broker-test-ledger.jsonl',
      ),
      deps,
    )
    expect(result.payload).toMatchObject({ _tag: 'Created', response: { ephemeral: true } })
    expect(result.payload).not.toHaveProperty('response.id')
    expect(recordOrder).toEqual(['record:thread:555555555555555555', 'close'])
  })

  it('returns observed docs replies without synthetic message IDs or ledger entries', async () => {
    const recordOrder: string[] = []
    const result = await dispatchBrokerOperation(
      makeInvocation('invoke-docs', { ...baseRequest, marker: 'm' }, '/tmp/broker-test-ledger.jsonl'),
      makeDeps({ evidence: { docsOutcome: 'answered', ephemeralResponseCount: 1 }, recordOrder }),
    )
    expect(result.payload).toMatchObject({ _tag: 'Answered', responses: [{ ephemeral: true, hasAnswer: true }] })
    expect(recordOrder).toEqual(['close'])
  })

  it('correlates public docs rows to app-authored REST IDs before journaling deletion', async () => {
    const recordOrder: string[] = []
    const observed: string[] = []
    const result = await dispatchBrokerOperation(
      makeInvocation('invoke-docs', { ...baseRequest, marker: 'm' }, '/tmp/broker-test-ledger.jsonl'),
      makeDeps({
        evidence: { docsOutcome: 'answered', publicResponseCount: 1 },
        snapshotPublicResponseIds: async () => {
          observed.push('before')
          return ['333333333333333333' as Snowflake]
        },
        waitForPublicResponses: async () => {
          observed.push('after')
          return ['444444444444444444' as Snowflake]
        },
        recordOrder,
      }),
    )
    expect(observed).toEqual(['before', 'after'])
    expect(result.payload).toMatchObject({ _tag: 'Answered', responses: [{ id: '444444444444444444' }] })
    expect(recordOrder).toEqual(['record:response:444444444444444444', 'close'])
  })

  it('marks each chunked docs answer as part of the answer', async () => {
    const deps = makeDeps({
      evidence: { docsOutcome: 'answered', responseMessageIds: ['444444444444444444', '477777777777777776'] },
      recordOrder: [],
    })
    const result = await dispatchBrokerOperation(
      makeInvocation('invoke-docs', { ...baseRequest, marker: 'm', channelId }, '/tmp/broker-test-ledger.jsonl'),
      deps,
    )
    const payload = result.payload as { responses: Array<{ hasAnswer: boolean; hasSources: boolean }> }
    expect(payload.responses.map((response) => response.hasAnswer)).toEqual([true, true])
    expect(payload.responses.every((response) => response.hasSources === true)).toBe(true)
  })

  it('resolves the ledger entry after a confirmed cleanup', async () => {
    const recordOrder: string[] = []
    const deps: AttendedBrokerDeps = {
      ...makeDeps({ evidence: {}, recordOrder }),
      driver: {
        perform: async () => {
          throw new Error('resolution must never drive the official client')
        },
      },
    }
    const result = await dispatchBrokerOperation(
      makeInvocation('resolve-response', { ...baseRequest, id: '444444444444444444' }, '/tmp/broker-test-ledger.jsonl'),
      deps,
    )
    expect(result.payload).toMatchObject({ resolved: true, id: '444444444444444444' })
    expect(recordOrder).toEqual(['resolve:response:444444444444444444', 'close'])
  })

  it('resolves thread cleanup without performing a second client gesture', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({ evidence: { declined: true }, recordOrder })
    const result = await dispatchBrokerOperation(
      makeInvocation('resolve-thread', { ...baseRequest, id: '555555555555555555' }, '/tmp/broker-test-ledger.jsonl'),
      deps,
    )

    expect(result.payload).toEqual({ resolved: true, id: '555555555555555555' })
    expect(recordOrder).toEqual(['resolve:thread:555555555555555555', 'close'])
  })

  it('leaves no unresolved artifacts after normal response, thread, and source cleanup', async () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'broker-normal-cleanup-')), 'cleanup.jsonl')
    const sourceId = '333333333333333333' as Snowflake
    const responseId = '444444444444444444' as Snowflake
    const threadId = '555555555555555555' as Snowflake
    const deps: AttendedBrokerDeps = {
      driver: {
        perform: async ({ operation }) => {
          if (operation === 'invoke-message-action') {
            return { messageActionOutcome: 'created', responseMessageIds: [responseId] }
          }
          return {}
        },
      },
      correlator: {
        waitForMessage: async () => ({ id: sourceId, channelId, marker: 'm', author: 'human' }),
        waitForThread: async () => threadId,
        snapshotPublicResponseIds: async () => [],
        waitForPublicResponses: async () => [],
        dispose: async () => undefined,
      },
      performer: 'official-client-session',
      openLedger: ({ filePath, runId }) => {
        const writer = openCleanupLedger({ filePath, runId })
        const cleanupIdentity = (entry: BrokerLedgerInput) => ({
          runId,
          scenario: undefined,
          kind: entry.kind,
          guildId: entry.guildId as Snowflake,
          channelId: entry.channelId as Snowflake,
          messageId: entry.messageId as Snowflake,
        })
        return {
          record: (entry) => writer.record(cleanupIdentity(entry)),
          resolve: (entry) => writer.resolve(cleanupIdentity(entry)),
          close: writer.close,
          recordMessageIntent: (entry) =>
            writer.recordMessageIntent({
              runId,
              guildId: entry.guildId as Snowflake,
              channelId: entry.channelId as Snowflake,
              marker: entry.marker,
            }),
          resolveMessageIntent: (entry) =>
            writer.resolveMessageIntent({
              runId,
              guildId: entry.guildId as Snowflake,
              channelId: entry.channelId as Snowflake,
              marker: entry.marker,
            }),
        }
      },
    }

    await dispatchBrokerOperation(
      makeInvocation('create-message', { ...baseRequest, marker: 'm', content: 'hello m' }, ledgerPath),
      deps,
    )
    await dispatchBrokerOperation(
      makeInvocation('invoke-message-action', { ...baseRequest, marker: 'm', sourceMessageId: sourceId }, ledgerPath),
      deps,
    )
    await dispatchBrokerOperation(
      makeInvocation('resolve-response', { ...baseRequest, id: responseId }, ledgerPath),
      deps,
    )
    await dispatchBrokerOperation(makeInvocation('resolve-thread', { ...baseRequest, id: threadId }, ledgerPath), deps)
    await dispatchBrokerOperation(makeInvocation('resolve-message', { ...baseRequest, id: sourceId }, ledgerPath), deps)

    expect(readUnresolvedEntries(ledgerPath).unresolved).toEqual([])
  })

  it('recovers the marker message after correlation times out', async () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'broker-timeout-')), 'cleanup.jsonl')
    const marker = '[unique-marker]'
    const messageId = '333333333333333333' as Snowflake
    const deps: AttendedBrokerDeps = {
      ...makeDeps({
        evidence: {},
        recordOrder: [],
        waitForMessage: async () => {
          throw new Error('correlation timed out')
        },
      }),
      driver: {
        perform: async () => {
          expect(readUnresolvedEntries(ledgerPath).unresolved).toEqual([
            expect.objectContaining({ kind: 'message-intent', marker }),
          ])
          return {}
        },
      },
      openLedger: ({ filePath, runId }) => {
        const writer = openCleanupLedger({ filePath, runId })
        return {
          record: () => {
            throw new Error('unexpected exact record')
          },
          resolve: () => {
            throw new Error('unexpected exact resolve')
          },
          recordMessageIntent: (entry) =>
            writer.recordMessageIntent({
              runId,
              guildId: entry.guildId as Snowflake,
              channelId: entry.channelId as Snowflake,
              marker: entry.marker,
            }),
          resolveMessageIntent: (entry) =>
            writer.resolveMessageIntent({
              runId,
              guildId: entry.guildId as Snowflake,
              channelId: entry.channelId as Snowflake,
              marker: entry.marker,
            }),
          close: writer.close,
        }
      },
    }
    await expect(
      dispatchBrokerOperation(
        makeInvocation('create-message', { ...baseRequest, marker, content: `thanks ${marker}` }, ledgerPath),
        deps,
      ),
    ).rejects.toThrow('correlation timed out')
    const deleted: string[] = []
    const recovery = makeRecoveryTransport({
      getChannel: async () => ({ id: channelId, guild_id: guildId }),
      listMessages: async () => [
        { id: messageId, channel_id: channelId, content: `thanks ${marker}`, author: { bot: false } },
      ],
      deleteChannel: async () => {
        throw new Error('unexpected thread deletion')
      },
      deleteMessage: async (_channel, id) => {
        deleted.push(id)
      },
    })
    const outcomes = await recoverCleanupLedger({
      filePath: ledgerPath,
      transport: recovery,
      findMessageByMarker: recovery.findMessageByMarker,
    })
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['deleted'])
    expect(deleted).toEqual([messageId])
    expect(readUnresolvedEntries(ledgerPath).unresolved).toEqual([])
  })
  it('keeps an unmatched intent open rather than declaring it already gone', async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'broker-unmatched-')), 'cleanup.jsonl')
    const writer = openCleanupLedger({ filePath, runId: 'test-run' })
    writer.recordMessageIntent({ runId: 'test-run', guildId, channelId, marker: '[missing]' })
    writer.close()
    const recovery = makeRecoveryTransport({
      getChannel: async () => ({ id: channelId, guild_id: guildId }),
      listMessages: async () => [],
      deleteChannel: async () => {
        throw new Error('unexpected thread deletion')
      },
      deleteMessage: async () => {
        throw new Error('unexpected message deletion')
      },
    })
    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: recovery,
      findMessageByMarker: recovery.findMessageByMarker,
    })
    expect(outcomes).toMatchObject([{ outcome: 'failed', entry: { kind: 'message-intent', marker: '[missing]' } }])
    expect(readUnresolvedEntries(filePath).unresolved).toHaveLength(1)
  })

  it('sends each scenario marker and preserves eligible and filtered admission verdicts', async () => {
    const target = {
      applicationId: '444444444444444444' as Snowflake,
      guildId,
      channelId,
      docsChannelIds: { public: channelId, restricted: channelId },
      allowedChannelIds: new Set([channelId]),
      requiredTopicSentinel: topicSentinel,
      pollIntervalMs: 1,
      timeoutMs: 4,
    }
    const world = makeFakeWorld(target)
    const scenarios: ScenarioId[] = [
      'automatic-eligible',
      'automatic-filtered',
      'automated-author-rejected',
      'operator-retroactive',
      'operator-idempotent',
      'operator-concurrent',
    ]
    const contents: Array<{ scenario: ScenarioId; content: string; marker: string }> = []
    let index = 0
    const receipt = await runE2EMatrix({
      environment: 'fake',
      target,
      selection: { _tag: 'Scenarios', scenarios },
      allowHumanAssisted: true,
      transport: {
        ...world.transport,
        createMessage: async (request) => {
          const scenario = scenarios[index++]!
          contents.push({ scenario, content: request.content, marker: request.marker })
          return world.transport.createMessage(request)
        },
      },
    })
    expect(
      receipt.scenarios
        .filter((scenario) => scenarios.includes(scenario.scenario))
        .every((scenario) => scenario.verdict === 'PASS'),
    ).toBe(true)
    expect(contents.map(({ scenario }) => scenario)).toEqual(scenarios)
    for (const { content, marker } of contents) {
      expect(content).toContain(marker)
      expect(buildCreateMessageSteps({ guildId, channelId, content })[2]?.stdinValue).toContain(marker)
    }
    expect(contents[0]!.content.startsWith('https://')).toBe(false)
    expect(new URL(contents[1]!.content).protocol).toBe('https:')
    expect(contents[1]!.content.startsWith('https://example.invalid/#')).toBe(true)
  })

  it('rejects non-object requests', async () => {
    await expect(
      dispatchBrokerOperation(makeInvocation('create-message', []), makeDeps({ evidence: {}, recordOrder: [] })),
    ).rejects.toThrow(/must be a JSON object/)
  })
})

describe('http-capture gesture step builders', () => {
  it('reveals the message toolbar before opening More and targets only the staging app command', () => {
    const steps = buildMessageActionSteps({ guildId, channelId, sourceMarkerText: '[m]' })
    expect(steps.slice(2).map(({ operation }) => operation)).toMatchObject([
      { kind: 'click', locator: { kind: 'css', selector: 'li[id^="chat-messages-"]:has-text("[m]")' } },
      {
        kind: 'click',
        locator: {
          kind: 'within',
          scope: { kind: 'css', selector: 'li[id^="chat-messages-"]:has-text("[m]")' },
          target: { kind: 'role', role: 'button', name: 'More' },
        },
      },
      { kind: 'click', locator: { kind: 'role', role: 'menuitem', name: 'Apps' } },
      { kind: 'click', locator: { kind: 'role', role: 'menuitem', name: 'LiveStore Auto Threads Staging' } },
      {
        kind: 'click',
        locator: {
          kind: 'within',
          scope: {
            kind: 'css',
            selector: '[role="menu"][aria-activedescendant^="message-actions-apps--"]:not(:has([role="menu"]))',
          },
          target: { kind: 'role', role: 'menuitem', name: 'Create Thread' },
        },
        effect: 'write',
      },
    ])
  })

  it('invokes docs with one full-command fill so the query stays bound to the command', () => {
    const steps = buildDocsCommandSteps({ guildId, channelId, query: 'syncing?' })
    expect(steps.slice(2)).toMatchObject([
      {
        operation: {
          kind: 'fill',
          locator: { kind: 'css', selector: expect.stringContaining('[aria-label^="Message #"]') },
        },
        stdinValue: '/docs query:syncing?',
      },
      { operation: { kind: 'press', key: 'Enter' } },
    ])
  })
})

describe('settledAppReplies', () => {
  const before = [{ text: 'older' }]
  const app = 'LiveStore Auto Threads Staging'

  it('reads until a new app row has settled past the deferred placeholder', async () => {
    const reads = [
      [...before, { text: `${app} is thinking...` }],
      [...before, { text: `${app} Answer with sources` }],
    ]
    let calls = 0
    const rows = await settledAppReplies(async () => reads[Math.min(calls++, reads.length - 1)]!, before, {
      intervalMs: 1,
    })
    expect(calls).toBe(2)
    expect(rows.at(-1)?.text).toContain('Answer')
  })

  it('returns the last read at the deadline when no app row appears', async () => {
    const rows = await settledAppReplies(async () => before, before, { timeoutMs: 5, intervalMs: 1 })
    expect(rows).toEqual(before)
  })
})

describe('projected Discord accessibility rows', () => {
  const marker = 'e2e-unique-marker'
  const before = parseMessageRows(`- main:
  - list "Messages":
    - listitem:
      - article "Casey":
        - generic: ${marker} source
    - listitem:
      - article "LiveStore Auto Threads Staging":
        - text: An earlier reply
`)
  it('finds new docs replies without mistaking the invoker or stale bot rows for a reply', () => {
    const after = parseMessageRows(`- main:
  - list "Messages":
    - listitem:
      - article "Casey":
        - generic: ${marker} source
    - listitem:
      - article "LiveStore Auto Threads Staging":
        - text: An earlier reply
    - listitem:
      - article "Casey":
        - text: /docs query:${marker} How does syncing work?
    - listitem:
      - article "LiveStore Auto Threads Staging APP":
        - paragraph: Syncing uses events and materializers.
        - paragraph: Sources
        - list:
          - listitem:
            - link "LiveStore documentation" [ref=e17]
`)
    expect(newAppReplies('invoke-docs', before, after, marker).map((row) => row.text)).toEqual([
      expect.stringContaining('Syncing uses events and materializers.'),
    ])
    expect(
      classifyReplies(
        'invoke-docs',
        newAppReplies('invoke-docs', before, after, marker).map((row) => row.text),
      ),
    ).toEqual({
      docsOutcome: 'answered',
    })
  })

  it('waits for an edited thinking row and classifies a message-action denial by bot text', async () => {
    const thinking = parseMessageRows(`- main:
  - listitem:
    - article "Casey":
      - text: ${marker} source
  - listitem:
    - article "LiveStore Auto Threads Staging APP":
      - text: ${marker} is thinking...
`)
    const denied = parseMessageRows(`- main:
  - listitem:
    - article "Casey":
      - text: ${marker} source
  - listitem:
    - article "LiveStore Auto Threads Staging APP":
      - text: ${marker} You do not have permission to create this thread. Only you can see this
`)
    let calls = 0
    const settled = await settledAppReplies(async () => (calls++ === 0 ? thinking : denied), before.slice(0, 1), {
      intervalMs: 1,
      marker,
    })
    expect(calls).toBe(2)
    const replies = newAppReplies('invoke-message-action', before.slice(0, 1), settled, marker)
    expect(
      classifyReplies(
        'invoke-message-action',
        replies.map((row) => row.text),
      ),
    ).toEqual({
      messageActionOutcome: 'denied',
    })
  })
})

describe('runReadStepAcrossDocumentReplacement', () => {
  const [navigate, ready, fill] = buildCreateMessageSteps({ guildId: '1', channelId: '2', content: 'x' })
  const failing = (codes: ReadonlyArray<string | undefined>) => {
    let calls = 0
    return {
      run: async () => {
        const code = codes[calls++]
        if (calls > codes.length) return 'ok'
        throw new CaptureGestureFailure('wait', 1, 1, code)
      },
      calls: () => calls,
    }
  }

  it('re-runs read-only steps after a document replacement', async () => {
    for (const step of [
      navigate!,
      ready!,
      { operation: { kind: 'snapshot' } } as const,
      { operation: { kind: 'locate', locator: { kind: 'css', selector: 'li[id^="chat-messages-"]' } } } as const,
    ]) {
      const probe = failing(['browser_unavailable', 'browser_unavailable'])
      await expect(runReadStepAcrossDocumentReplacement(step, probe.run)).resolves.toBe('ok')
      expect(probe.calls()).toBe(3)
    }
  })

  it('never re-runs writes, other failures, or beyond the attempt bound', async () => {
    const write = failing(['browser_unavailable'])
    await expect(runReadStepAcrossDocumentReplacement(fill!, write.run)).rejects.toBeInstanceOf(CaptureGestureFailure)
    expect(write.calls()).toBe(1)
    const notFound = failing(['locator_not_found'])
    await expect(runReadStepAcrossDocumentReplacement(ready!, notFound.run)).rejects.toMatchObject({
      code: 'locator_not_found',
    })
    expect(notFound.calls()).toBe(1)
    const persistent = failing(['browser_unavailable', 'browser_unavailable', 'browser_unavailable'])
    await expect(runReadStepAcrossDocumentReplacement(ready!, persistent.run)).rejects.toMatchObject({
      code: 'browser_unavailable',
    })
    expect(persistent.calls()).toBe(3)
  })
})

describe('classifyReplies', () => {
  it("uses the bot's own texts: a docs denial is denied and a non-answer never counts as answered", () => {
    expect(
      classifyReplies('invoke-docs', [
        'LiveStore Auto Threads Staging APP This channel or role is not configured for the documentation assistant. Only you can see this',
      ]),
    ).toEqual({ docsOutcome: 'denied' })
    expect(classifyReplies('invoke-docs', ['LiveStore Auto Threads Staging APP Events are defined with …'])).toEqual({
      docsOutcome: 'answered',
    })
    expect(() =>
      classifyReplies('invoke-docs', [
        'LiveStore Auto Threads Staging APP The documentation assistant could not produce a source-backed answer. Please try again later.',
      ]),
    ).toThrow('unavailable notice')
    expect(
      classifyReplies('invoke-message-action', [
        '… You do not have permission to create this thread. Only you can see this',
      ]),
    ).toEqual({ messageActionOutcome: 'denied' })
  })
})
