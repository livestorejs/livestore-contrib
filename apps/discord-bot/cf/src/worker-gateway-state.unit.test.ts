import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { Schema } from 'effect'
import { expect, it } from 'vitest'

import { DiscordMessageRef } from '../../src/threading/model.ts'
import { makeWorkerGatewayState } from './worker-gateway-state.ts'

it('fences stale owners and retains retrying references through handoff and park', () => {
  const db = new DatabaseSync(':memory:')
  const values = new Map<string, unknown>()
  const storage = {
    kv: {
      get: (key: string) => values.get(key),
      put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
      delete: (key: string) => values.delete(key),
    },
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        const statement = db.prepare(query)
        if (query.startsWith('SELECT') === false) statement.run(...bindings)
        return { toArray: () => statement.all(...bindings), one: () => statement.get(...bindings) }
      },
    },
    transactionSync: (callback: () => unknown) => {
      db.exec('BEGIN')
      try {
        const result = callback()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as DurableObjectStorage
  const source = (messageId: string) =>
    Schema.decodeSync(DiscordMessageRef)({ guildId: '100000000000000001', channelId: '100000000000000002', messageId })
  const first = source('100000000000000003')
  const later = source('100000000000000004')
  const saved = { sessionId: 'fixture', sequence: 7, resumeUrl: 'wss://gateway.discord.gg' }
  let now = 1_000
  try {
    const state = makeWorkerGatewayState(storage, 'version-one', () => now)
    state.initOutbox()
    expect(state.claim('old', now + 90_000)).toBeDefined()
    expect(state.capture('old', first)).toBe(true)
    expect(state.capture('old', first)).toBe(true)
    expect(state.capture('old', later)).toBe(true)
    expect(state.checkpoint('old', saved)).toBe(true)
    const upgraded = makeWorkerGatewayState(storage, 'version-two', () => now)
    expect(upgraded.current()).toBeUndefined()
    expect(upgraded.report().ownerActive).toBe(false)
    expect(upgraded.renew('old', true, now)).toBeUndefined()
    expect(upgraded.claim('upgraded', now + 90_000)).toBeUndefined()
    state.revoke()
    expect(state.renew('old', true, now)).toBeUndefined()
    expect(state.capture('old', later)).toBe(false)
    expect(state.claim('replacement', now + 90_000)).toBeUndefined()

    state.release('old')
    expect(state.claim('replacement', now + 90_000)?.session).toEqual(saved)
    expect(state.checkpoint('old', { ...saved, sequence: 8 })).toBe(false)
    state.release('old')
    expect(state.renew('replacement', true, now, 'Resumed')).toBe(now + 90_000)
    expect(state.report()).toMatchObject({ ownerActive: true, resumedCount: 1, lastHeartbeatAt: now })

    const entry = state.next()
    if (entry === undefined) throw new Error('Missing pending source')
    expect(entry.messageId).toBe(first.messageId)
    state.finish(entry, false)
    expect(state.next()?.messageId).toBe(later.messageId)
    now += 30_000
    expect(state.next()?.messageId).toBe(first.messageId)
  } finally {
    db.close()
  }
})
