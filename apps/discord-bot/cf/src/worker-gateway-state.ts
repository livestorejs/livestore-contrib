import type { ShardState } from 'dfx/DiscordGateway/Shard/StateStore'

import type { DiscordMessageRef } from '../../src/threading/model.ts'
import { shardStateKey } from './storage.ts'

const leaseKey = 'worker-gateway-lease'
const reportKey = 'worker-gateway-report'
const releasedAtKey = 'worker-gateway-released-at'
const outboxKey = 'worker-gateway-outbox-present'
const maintenanceKey = 'worker-gateway-maintenance-at'
const sessionKey = shardStateKey([0, 1])
const ttl = 90_000
const maximumPending = 10_000
const hour = 3_600_000

interface Lease {
  readonly owner: string
  readonly version: string
  readonly expiresAt: number
  readonly until: number
  readonly ready: boolean
  readonly revoked?: boolean
}

interface Counters {
  readonly readyCount: number
  readonly resumedCount: number
  readonly lastHeartbeatAt?: number
  readonly lastHandoffMs?: number
}

export interface WorkerGatewayReport extends Counters {
  readonly ownerActive: boolean
}

interface Pending {
  readonly guildId: string
  readonly channelId: string
  readonly messageId: string
  readonly attempts: number
}

/** The BotState singleton fences the socket, cursor, and reference intake together. */
export const makeWorkerGatewayState = (storage: DurableObjectStorage, version: string, now = Date.now) => {
  const { kv, sql } = storage
  const counters = () => kv.get<Counters>(reportKey) ?? { readyCount: 0, resumedCount: 0 }
  let outboxInitialized = false
  const reserved = () => {
    const lease = kv.get<Lease>(leaseKey)
    return lease !== undefined && lease.expiresAt > now() ? lease : undefined
  }

  const current = () => {
    const lease = reserved()
    return lease?.version === version && lease.revoked !== true ? lease : undefined
  }

  return {
    claim: (owner: string, until: number) =>
      storage.transactionSync(() => {
        if (reserved() !== undefined || until <= now()) return undefined
        const expiresAt = Math.min(until, now() + ttl)
        kv.put(leaseKey, { owner, version, expiresAt, until, ready: false })
        return { until, expiresAt, session: kv.get<ShardState>(sessionKey) }
      }),
    renew: (owner: string, ready: boolean, ackAt: number, event?: 'Ready' | 'Resumed') =>
      storage.transactionSync(() => {
        const lease = current()
        if (lease?.owner !== owner) return undefined
        const expiresAt = Math.min(lease.until, now() + ttl)
        kv.put(leaseKey, { ...lease, ready, expiresAt })
        const prior = counters()
        if (event !== undefined || ackAt > (prior.lastHeartbeatAt ?? 0)) {
          const releasedAt = event === undefined ? undefined : kv.get<number>(releasedAtKey)
          kv.put(reportKey, {
            ...prior,
            readyCount: prior.readyCount + Number(event === 'Ready'),
            resumedCount: prior.resumedCount + Number(event === 'Resumed'),
            ...(releasedAt === undefined ? {} : { lastHandoffMs: now() - releasedAt }),
            ...(ackAt > (prior.lastHeartbeatAt ?? 0) ? { lastHeartbeatAt: ackAt } : {}),
          })
          if (releasedAt !== undefined) kv.delete(releasedAtKey)
        }
        return expiresAt
      }),
    checkpoint: (owner: string, session: ShardState | undefined) =>
      storage.transactionSync(() => {
        if (current()?.owner !== owner) return false
        if (session === undefined) kv.delete(sessionKey)
        else kv.put(sessionKey, session)
        return true
      }),
    allowIdentify: (owner: string) =>
      storage.transactionSync(() => {
        if (current()?.owner !== owner) return false
        const recent = (kv.get<number[]>('worker-gateway-identifies') ?? []).filter((at) => now() - at < hour)
        if (recent.length >= 12) return false
        kv.put('worker-gateway-identifies', [...recent, now()])
        return true
      }),
    release: (owner: string) =>
      storage.transactionSync(() => {
        if (kv.get<Lease>(leaseKey)?.owner !== owner) return
        kv.delete(leaseKey)
        kv.put(releasedAtKey, now())
      }),
    revoke: () => {
      const lease = reserved()
      if (lease !== undefined) kv.put(leaseKey, { ...lease, revoked: true, ready: false })
    },
    reserved,
    current,
    report: (): WorkerGatewayReport => ({ ...counters(), ownerActive: current() !== undefined }),
    hasOutbox: () => outboxInitialized === true || kv.get<boolean>(outboxKey) === true,
    initOutbox: () => {
      if (outboxInitialized === true) return
      sql.exec(`CREATE TABLE IF NOT EXISTS worker_gateway_outbox (
        ordinal INTEGER PRIMARY KEY,
        guildId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        messageId TEXT UNIQUE NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        retryAt INTEGER NOT NULL DEFAULT 0
      ) STRICT`)
      kv.put(outboxKey, true)
      outboxInitialized = true
    },
    capture: (owner: string, ref: DiscordMessageRef) =>
      storage.transactionSync(() => {
        if (current()?.owner !== owner) return false
        const { guildId, channelId, messageId } = ref
        sql.exec(
          'INSERT OR IGNORE INTO worker_gateway_outbox (guildId, channelId, messageId) VALUES (?, ?, ?)',
          guildId,
          channelId,
          messageId,
        )
        const count = sql.exec<{ count: number }>('SELECT count(*) AS count FROM worker_gateway_outbox').one().count
        if (count > maximumPending) {
          throw new Error('Gateway reference outbox is full')
        }
        return true
      }),
    needsMaintenance: () => now() - (kv.get<number>(maintenanceKey) ?? 0) >= hour,
    maintained: () => {
      kv.put(maintenanceKey, now())
    },
    next: () =>
      sql
        .exec<Pending & Record<string, SqlStorageValue>>(
          'SELECT guildId, channelId, messageId, attempts FROM worker_gateway_outbox WHERE retryAt <= ? ORDER BY ordinal LIMIT 1',
          now(),
        )
        .toArray()[0],
    finish: (entry: Pending, handled: boolean) => {
      if (handled === true) {
        sql.exec('DELETE FROM worker_gateway_outbox WHERE messageId = ?', entry.messageId)
        return
      }
      const delay = Math.min(30_000 * 2 ** Math.min(entry.attempts, 6), 30 * 60_000)
      sql.exec(
        'UPDATE worker_gateway_outbox SET attempts = attempts + 1, retryAt = ? WHERE messageId = ?',
        now() + delay,
        entry.messageId,
      )
    },
  }
}
