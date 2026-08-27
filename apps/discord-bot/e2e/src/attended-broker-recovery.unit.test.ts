import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { makeRecoveryTransport, type RecoveryDiscordApi } from './attended-broker-recovery.ts'
import { openCleanupLedger, readUnresolvedEntries, recoverCleanupLedger } from './cleanup-ledger.ts'
import type { Snowflake } from './model.ts'

const guildId = '111111111111111111' as Snowflake
const channelId = '222222222222222222' as Snowflake
const threadId = '333333333333333333' as Snowflake
const responseId = '444444444444444444' as Snowflake
const runId = 'recovery-test-run'

const ledgerWith = (kind: 'thread' | 'response'): string => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'broker-recovery-')), 'cleanup.jsonl')
  const writer = openCleanupLedger({ filePath, runId })
  writer.record({ runId, scenario: undefined, kind, guildId, channelId, messageId: kind === 'thread' ? threadId : responseId })
  writer.close()
  return filePath
}

const makeDiscord = (overrides: Partial<RecoveryDiscordApi>): RecoveryDiscordApi => ({
  getChannel: overrides.getChannel ?? (async () => ({ id: channelId, guild_id: guildId, type: 0 })),
  deleteChannel: overrides.deleteChannel ?? (async () => undefined),
  deleteMessage: overrides.deleteMessage ?? (async () => undefined),
})

describe('attended broker recovery transport', () => {
  it.each([
    ['archived', 11],
    ['private', 12],
  ])('finds and deletes a %s thread by exact channel id', async (_kind, type) => {
    const filePath = ledgerWith('thread')
    const deleteChannel = vi.fn(async () => undefined)
    const getChannel = vi.fn(async () => ({
      id: threadId,
      guild_id: guildId,
      parent_id: channelId,
      type,
      thread_metadata: { archived: true },
    }))

    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeRecoveryTransport(makeDiscord({ getChannel, deleteChannel })),
    })

    expect(getChannel).toHaveBeenCalledWith(threadId)
    expect(deleteChannel).toHaveBeenCalledWith(threadId)
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['deleted'])
    expect(readUnresolvedEntries(filePath).unresolved).toEqual([])
  })

  it('treats an exact getChannel 404 as already gone', async () => {
    const filePath = ledgerWith('thread')
    const deleteChannel = vi.fn(async () => undefined)
    const notFound = Object.assign(new Error('unknown channel'), { response: { status: 404 } })

    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeRecoveryTransport(
        makeDiscord({
          getChannel: async () => Promise.reject(notFound),
          deleteChannel,
        }),
      ),
    })

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['already-gone'])
    expect(deleteChannel).not.toHaveBeenCalled()
    expect(readUnresolvedEntries(filePath).unresolved).toEqual([])
  })

  it.each([
    ['guild', { guild_id: '999999999999999999', parent_id: channelId }],
    ['parent', { guild_id: guildId, parent_id: '999999999999999999' }],
  ])('refuses to delete an archived thread with the wrong %s', async (_field, mismatch) => {
    const filePath = ledgerWith('thread')
    const deleteChannel = vi.fn(async () => undefined)
    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeRecoveryTransport(
        makeDiscord({
          getChannel: async () => ({ id: threadId, type: 12, ...mismatch }),
          deleteChannel,
        }),
      ),
    })

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['failed'])
    expect(deleteChannel).not.toHaveBeenCalled()
    expect(readUnresolvedEntries(filePath).unresolved).toHaveLength(1)
  })

  it('resolves a response that becomes a 404 between validation and deletion', async () => {
    const filePath = ledgerWith('response')
    const notFound = Object.assign(new Error('unknown message'), { response: { status: 404 } })
    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeRecoveryTransport(
        makeDiscord({
          deleteMessage: async () => Promise.reject(notFound),
        }),
      ),
    })

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['already-gone'])
    expect(readUnresolvedEntries(filePath).unresolved).toEqual([])
  })

  it('deletes a response with its recorded channel, never its response id as channel', async () => {
    const filePath = ledgerWith('response')
    const deleteMessage = vi.fn(async () => undefined)
    const outcomes = await recoverCleanupLedger({
      filePath,
      transport: makeRecoveryTransport(makeDiscord({ deleteMessage })),
    })

    expect(deleteMessage).toHaveBeenCalledExactlyOnceWith(channelId, responseId)
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['deleted'])
    expect(readUnresolvedEntries(filePath).unresolved).toEqual([])
  })
})
