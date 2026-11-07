import { DatabaseSync } from 'node:sqlite'

import type { ShardState } from 'dfx/DiscordGateway/Shard/StateStore'

import type { DiscordMessageRef } from '../threading/model.ts'

/** Store references only. The action authority reads the current message from Discord. */
export const openRelayOutbox = (path: string, capacity: number) => {
  if (Number.isSafeInteger(capacity) === false || capacity <= 0) throw new Error('Invalid relay outbox capacity')

  const db = new DatabaseSync(path)
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS relay_outbox (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relay_session (
        shard TEXT PRIMARY KEY,
        resumeUrl TEXT NOT NULL,
        sequence INTEGER,
        sessionId TEXT NOT NULL
      ) STRICT;
    `)

    const enqueue = db.prepare(`
      INSERT INTO relay_outbox (guild_id, channel_id, message_id)
      SELECT ?, ?, ?
      WHERE (SELECT count(*) FROM relay_outbox) < ?
      ON CONFLICT(message_id) DO NOTHING
    `)
    const contains = db.prepare('SELECT 1 FROM relay_outbox WHERE message_id = ?')
    const oldest = db.prepare(`
      SELECT ordinal, guild_id AS guildId, channel_id AS channelId, message_id AS messageId
      FROM relay_outbox ORDER BY ordinal LIMIT 1
    `)
    const remove = db.prepare('DELETE FROM relay_outbox WHERE ordinal = ? AND message_id = ?')

    const loadSession = db.prepare('SELECT resumeUrl, sequence, sessionId FROM relay_session WHERE shard = ?')
    const saveSession = db.prepare('INSERT OR REPLACE INTO relay_session VALUES (?, ?, ?, ?)')
    const clearSession = db.prepare('DELETE FROM relay_session WHERE shard = ?')

    return {
      session: (shard: string) => loadSession.get(shard) as ShardState | undefined,
      saveSession: (shard: string, state: ShardState) => {
        saveSession.run(shard, state.resumeUrl, state.sequence, state.sessionId)
      },
      clearSession: (shard: string) => {
        clearSession.run(shard)
      },
      enqueue: (source: DiscordMessageRef) => {
        const result = enqueue.run(source.guildId, source.channelId, source.messageId, capacity)
        if (result.changes === 0 && contains.get(source.messageId) === undefined) {
          throw new Error('Relay outbox is full')
        }
      },
      next: () => oldest.get() as (DiscordMessageRef & { readonly ordinal: number }) | undefined,
      acknowledge: (entry: DiscordMessageRef & { readonly ordinal: number }) => {
        remove.run(entry.ordinal, entry.messageId)
      },
      close: () => db.close(),
    }
  } catch (error) {
    db.close()
    throw error
  }
}

export type RelayOutbox = ReturnType<typeof openRelayOutbox>
