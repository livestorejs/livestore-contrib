import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildCreateMessageSteps,
  buildDocsCommandSteps,
  buildMessageActionSteps,
} from './attended-broker-driver.ts'
import {
  dispatchBrokerOperation,
  parseBrokerInvocation,
  type AttendedBrokerDeps,
  type BrokerLedgerInput,
  type BrokerOperation,
  type GestureEvidence,
} from './attended-broker.ts'
import { openCleanupLedger, readUnresolvedEntries } from './cleanup-ledger.ts'
import type { Snowflake } from './model.ts'

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
    dispose: async () => undefined,
  },
  performer: 'official-client-session',
  openLedger: () => ({
    record: (entry: BrokerLedgerInput) => input.recordOrder.push(`record:${entry.kind}:${entry.messageId}`),
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

  it('requires the run id when a ledger is configured', () => {
    expect(
      parseBrokerInvocation(['create-message', '--request-json', '{}', '--ledger', '/tmp/l.jsonl'])._tag,
    ).toBe('UsageError')
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
    const result = await dispatchBrokerOperation(makeInvocation('create-message', { ...baseRequest, marker: 'm' }, '/tmp/broker-test-ledger.jsonl'), deps)
    expect(result.declineExitCode).toBeUndefined()
    expect(result.payload).toMatchObject({ id: '333333333333333333', performedBy: 'official-client-session' })
    expect(recordOrder).toEqual(['record:message:333333333333333333', 'close'])
  })

  it('maps an operator decline to exit code 7 without touching the ledger', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({ evidence: { declined: true }, recordOrder })
    const result = await dispatchBrokerOperation(makeInvocation('create-message', { ...baseRequest, marker: 'm' }, '/tmp/broker-test-ledger.jsonl'), deps)
    expect(result.declineExitCode).toBe(7)
    expect(recordOrder).toEqual([])
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

  it('marks only the first chunked docs reply as carrying the answer', async () => {
    const deps = makeDeps({
      evidence: { docsOutcome: 'answered', responseMessageIds: ['444444444444444444', '477777777777777776'] },
      recordOrder: [],
    })
    const result = await dispatchBrokerOperation(
      makeInvocation('invoke-docs', { ...baseRequest, marker: 'm', channelId }, '/tmp/broker-test-ledger.jsonl'),
      deps,
    )
    const payload = result.payload as { responses: Array<{ hasAnswer: boolean; hasSources: boolean }> }
    expect(payload.responses.map((response) => response.hasAnswer)).toEqual([true, false])
    expect(payload.responses.every((response) => response.hasSources === true)).toBe(true)
  })

  it('resolves the ledger entry after a confirmed cleanup', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({ evidence: {}, recordOrder })
    const result = await dispatchBrokerOperation(
      makeInvocation(
      'delete-response',
      { ...baseRequest, id: '444444444444444444', marker: 'm' },
      '/tmp/broker-test-ledger.jsonl',
    ),
      deps,
    )
    expect(result.payload).toMatchObject({ deleted: true, id: '444444444444444444' })
    expect(recordOrder).toEqual(['resolve:response:444444444444444444', 'close'])
  })

  it('resolves thread cleanup without performing a second client gesture', async () => {
    const recordOrder: string[] = []
    const deps = makeDeps({ evidence: { declined: true }, recordOrder })
    const result = await dispatchBrokerOperation(
      makeInvocation(
        'resolve-thread',
        { ...baseRequest, id: '555555555555555555' },
        '/tmp/broker-test-ledger.jsonl',
      ),
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
        }
      },
    }

    await dispatchBrokerOperation(
      makeInvocation('create-message', { ...baseRequest, marker: 'm' }, ledgerPath),
      deps,
    )
    await dispatchBrokerOperation(
      makeInvocation('invoke-message-action', { ...baseRequest, marker: 'm', sourceMessageId: sourceId }, ledgerPath),
      deps,
    )
    await dispatchBrokerOperation(
      makeInvocation('delete-response', { ...baseRequest, id: responseId, marker: 'm' }, ledgerPath),
      deps,
    )
    await dispatchBrokerOperation(makeInvocation('resolve-thread', { ...baseRequest, id: threadId }, ledgerPath), deps)
    await dispatchBrokerOperation(
      makeInvocation('delete-message', { ...baseRequest, id: sourceId, marker: 'm' }, ledgerPath),
      deps,
    )

    expect(readUnresolvedEntries(ledgerPath).unresolved).toEqual([])
  })

  it('rejects non-object requests', async () => {
    await expect(
      dispatchBrokerOperation(makeInvocation('create-message', []), makeDeps({ evidence: {}, recordOrder: [] })),
    ).rejects.toThrow(/must be a JSON object/)
  })
})

describe('http-capture gesture step builders', () => {
  it('navigates to the exact channel and sends content through the composer', () => {
    expect(buildCreateMessageSteps({ guildId, channelId, content: 'hello [m]' })).toEqual([
      { operation: 'navigate', url: `https://discord.com/channels/${guildId}/${channelId}` },
      { operation: 'wait', locator: { kind: 'role', name: 'textbox' }, state: 'visible', timeoutMs: 15000 },
      { operation: 'fill', locator: { kind: 'role', name: 'textbox' }, value: 'hello [m]', timeoutMs: 10000 },
      { operation: 'press', locator: { kind: 'role', name: 'textbox' }, key: 'Enter', timeoutMs: 5000 },
    ])
  })

  it('scopes the message action menu to the marked source row', () => {
    const steps = buildMessageActionSteps({ guildId, channelId, sourceMarkerText: '[m]' })
    expect(steps[0]).toMatchObject({ operation: 'navigate' })
    expect(steps.at(-1)).toMatchObject({ operation: 'click', locator: { kind: 'role', name: 'Create Thread' } })
  })

  it('invokes the docs slash command with the query', () => {
    const steps = buildDocsCommandSteps({ guildId, channelId, query: 'how does syncing work?' })
    expect(steps[2]).toMatchObject({
      operation: 'fill',
      value: '/docs how does syncing work?',
    })
  })
})
