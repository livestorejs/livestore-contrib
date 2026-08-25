import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { openCleanupLedger, readUnresolvedEntries, recoverCleanupLedger } from './cleanup-ledger.ts'
import type { Snowflake, ThreadSnapshot } from './model.ts'
import { E2EPrerequisiteUnavailableError, type E2ETransport } from './transport.ts'

const runId = '018f4d2e-7c1a-4b3e-9a2f-6d8c5e1f0a4b'

const identity = (overrides: Partial<Parameters<ReturnType<typeof openCleanupLedger>['record']>[0]> = {}) => ({
  runId,
  scenario: 'automatic-eligible' as const,
  kind: 'message' as const,
  guildId: '111111111111111111' as Snowflake,
  channelId: '222222222222222222' as Snowflake,
  messageId: '333333333333333333' as Snowflake,
  ...overrides,
})

const makeTmpPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-ledger-'))
  return join(dir, 'cleanup.jsonl')
}

/** Structural partial: only the members a given test drives; the rest reject loudly. */
const makeTransportStub = (overrides: Partial<E2ETransport>): E2ETransport => {
  const unused = (): Promise<never> => Promise.reject(new Error('not used by this test'))
  return {
    inspectChannel: overrides.inspectChannel ?? (() => unused()),
    createMessage: overrides.createMessage ?? (() => unused()),
    findThreadForMessage: overrides.findThreadForMessage ?? (() => unused()),
    operatorCreateThread: overrides.operatorCreateThread ?? (() => unused()),
    invokeMessageAction: overrides.invokeMessageAction ?? (() => unused()),
    invokeDocs: overrides.invokeDocs ?? (() => unused()),
    deleteThread: overrides.deleteThread ?? (() => unused()),
    deleteMessage: overrides.deleteMessage ?? (() => unused()),
    deleteResponse: overrides.deleteResponse ?? (() => unused()),
  }
}

const threadSnapshot = (id: Snowflake): ThreadSnapshot => ({
  id,
  guildId: '111111111111111111' as Snowflake,
  parentChannelId: '222222222222222222' as Snowflake,
  sourceMessageId: id,
  marker: '[livestore-discord-e2e]',
})

describe('cleanup ledger', () => {
  it('writes an open line before record() returns, so ack can never precede the ledger', () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })

    writer.record(identity())

    const lines = readFileSync(filePath, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ runId, kind: 'message', status: 'open' })
    writer.close()
  })

  it('creates new ledgers with mode 0600', () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })

    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    writer.close()
  })

  it('tightens a pre-existing ledger to mode 0600 before writing', () => {
    const filePath = makeTmpPath()
    writeFileSync(filePath, '', { mode: 0o644 })
    chmodSync(filePath, 0o666)

    const writer = openCleanupLedger({ filePath, runId })
    writer.record(identity())

    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(readFileSync(filePath, 'utf8')).toContain('"status":"open"')
    writer.close()
  })

  it('round-trips record then resolve to zero unresolved entries', () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })

    writer.record(identity())
    writer.resolve(identity())

    const { unresolved, warnings } = readUnresolvedEntries(filePath)
    expect(unresolved).toEqual([])
    expect(warnings).toEqual([])
    writer.close()
  })

  it('keeps an entry unresolved when its resolve line is missing', () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })
    const resolvedId = '444444444444444444' as Snowflake

    writer.record(identity())
    writer.record(identity({ messageId: resolvedId }))
    writer.resolve(identity())

    const { unresolved } = readUnresolvedEntries(filePath)
    expect(unresolved.map((entry) => entry.messageId)).toEqual([resolvedId])
    writer.close()
  })

  it('collects malformed lines as warnings without throwing or blocking good entries', () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })
    writer.record(identity())
    writer.close()

    // Torn crash mid-write and a wrong-schema line must not poison recovery.
    appendRaw(filePath, '{torn')
    appendRaw(filePath, JSON.stringify({ schemaVersion: 2, runId, kind: 'message', status: 'open' }))
    appendRaw(filePath, '')

    const { unresolved, warnings } = readUnresolvedEntries(filePath)
    expect(unresolved).toHaveLength(1)
    expect(warnings).toHaveLength(2)
  })

  it('rejects writes scoped to another run', () => {
    const writer = openCleanupLedger({ filePath: makeTmpPath(), runId })

    expect(() => writer.record(identity({ runId: 'other-run' }))).toThrow(/scoped to run/)
  })

  it('recovers unresolved entries by exact id and marks them resolved', async () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })
    const messageId = '333333333333333333' as Snowflake
    const threadMessageId = '555555555555555555' as Snowflake
    const responseId = '666666666666666666' as Snowflake
    writer.record(identity({ messageId }))
    writer.record(identity({ kind: 'thread', messageId: threadMessageId }))
    writer.record(identity({ kind: 'response', scenario: undefined, messageId: responseId }))
    writer.close()

    const deletedMessages: Snowflake[] = []
    const deletedThreads: Snowflake[] = []
    const deletedResponses: Snowflake[] = []
    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeTransportStub({
        inspectChannel: async () => ({ id: '222222222222222222' as Snowflake, guildId: '111111111111111111' as Snowflake, topic: undefined }),
        findThreadForMessage: async (_guildId, sourceMessageId) =>
          sourceMessageId === threadMessageId ? threadSnapshot(sourceMessageId) : undefined,
        deleteMessage: async (_channelId, id) => {
          deletedMessages.push(id)
        },
        deleteThread: async (id) => {
          deletedThreads.push(id)
        },
        deleteResponse: async (id) => {
          deletedResponses.push(id)
        },
      }),
    })

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['deleted', 'deleted', 'deleted'])
    expect(deletedMessages).toEqual([messageId])
    expect(deletedThreads).toEqual([threadMessageId])
    expect(deletedResponses).toEqual([responseId])
    expect(readUnresolvedEntries(filePath).unresolved).toEqual([])
  })

  it('reports already-gone for a vanished thread without deleting anything', async () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })
    const threadMessageId = '555555555555555555' as Snowflake
    writer.record(identity({ kind: 'thread', messageId: threadMessageId }))
    writer.close()

    let deletes = 0
    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeTransportStub({
        findThreadForMessage: async () => undefined,
        deleteThread: async () => {
          deletes += 1
        },
      }),
    })

    expect(outcomes).toEqual([{ entry: expect.objectContaining({ kind: 'thread' }), outcome: 'already-gone' }])
    expect(deletes).toBe(0)
    expect(readUnresolvedEntries(filePath).unresolved).toEqual([])
  })

  it('leaves a failed deletion unresolved and continues with the remaining entries', async () => {
    const filePath = makeTmpPath()
    const writer = openCleanupLedger({ filePath, runId })
    const failingId = '333333333333333333' as Snowflake
    const survivingId = '444444444444444444' as Snowflake
    writer.record(identity({ messageId: failingId }))
    writer.record(identity({
      messageId: survivingId,
      channelId: '777777777777777777' as Snowflake,
    }))
    writer.close()

    const failure = new Error('discord said no')
    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeTransportStub({
        inspectChannel: async (channelId) => {
          if (channelId === '222222222222222222') throw failure
          return { id: channelId, guildId: '111111111111111111' as Snowflake, topic: undefined }
        },
        deleteMessage: async () => undefined,
      }),
    })

    expect(outcomes).toEqual([
      { entry: expect.objectContaining({ messageId: failingId }), outcome: 'failed', error: failure },
      { entry: expect.objectContaining({ messageId: survivingId }), outcome: 'deleted' },
    ])
    expect(readUnresolvedEntries(filePath).unresolved.map((entry) => entry.messageId)).toEqual([failingId])
  })
})

const appendRaw = (filePath: string, line: string): void => {
  const fd = openSync(filePath, 'a')
  try {
    writeFileSync(fd, `${line}\n`)
  } finally {
    closeSync(fd)
  }
}
