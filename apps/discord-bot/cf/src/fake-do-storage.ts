import { DatabaseSync } from 'node:sqlite'

import type { DurableStorage } from './storage.ts'

export interface FakeDoStorage extends DurableStorage {
  readonly sql: {
    readonly exec: (query: string, ...bindings: SqlStorageValue[]) => {
      readonly columnNames: string[]
      readonly rowsRead: number
      readonly rowsWritten: number
      raw(): IterableIterator<unknown[]>
    }
  }
  readonly transaction: (fn: (txn: { rollback(): void }) => unknown) => Promise<unknown>
  setAlarm: (timestamp: number | Date) => Promise<void>
  deleteAlarm: () => Promise<void>
  getAlarm: () => Promise<number | undefined>
  sync: () => void
  close: () => void
}

/**
 * TEST-ONLY fake of the Cloudflare Durable Object storage surface, backed by
 * node:sqlite — journal logic is unit-testable outside workers. Hardened per
 * the reviewed derisk verdict: multi-statement SQL strings are REJECTED (the
 * real `SqlStorage.exec` refuses them too), so driver usage cannot quietly
 * depend on node:sqlite's lenient `exec`.
 *
 * Transaction semantics mirror the DO contract consumed by the driver: the
 * closure may return a promise; COMMIT happens only after it resolves,
 * ROLLBACK if it rejects or `txn.rollback()` was invoked first.
 */
export const makeFakeDoStorage = (dbFile = ':memory:'): FakeDoStorage => {
  const db = new DatabaseSync(dbFile)
  db.exec('PRAGMA journal_mode = WAL')

  const keyValues = new Map<string, unknown>()

  return {
    sql: {
      exec(query, ...bindings) {
        if (/;\s*\S/.test(query.trimEnd())) {
          throw new Error('fake DoStorage rejects multi-statement SQL')
        }
        const statement = db.prepare(query)
        // node:sqlite binds Uint8Array, not ArrayBuffer (which SqlStorage
        // uses for blobs); normalize before binding.
        const params = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value))
        const rows = params.length > 0 ? statement.all(...params) : statement.all()
        // Rows are plain objects; column order derives from the first row.
        // Limitation vs real DO: empty result sets report no columns.
        const columnNames = rows.length > 0 ? Object.keys(rows[0] as object) : []
        return {
          columnNames,
          rowsRead: 0,
          rowsWritten: 0,
          *raw() {
            for (const row of rows as Array<Record<string, unknown>>) {
              yield Object.values(row)
            }
          },
        }
      },
    },

    transaction(fn) {
      db.exec('BEGIN IMMEDIATE')
      let settled = false
      const txn = {
        rollback() {
          if (settled === false) {
            settled = true
            db.exec('ROLLBACK')
          }
        },
      }
      return Promise.resolve().then(
        () => fn(txn),
      ).then(
        (out) => {
          if (settled === false) {
            settled = true
            db.exec('COMMIT')
          }
          return out
        },
        (cause) => {
          if (settled === false) {
            settled = true
            try {
              db.exec('ROLLBACK')
            } catch {
              // SQLite already aborted; surface the original failure.
            }
          }
          throw cause
        },
      )
    },

    get: async <T>(key: string): Promise<T | undefined> => keyValues.get(key) as T | undefined,
    put: async <T>(key: string, value: T): Promise<T> => {
      keyValues.set(key, value)
      return value
    },
    delete: async (key: string): Promise<boolean> => keyValues.delete(key),
    list: async <T>(options?: { prefix?: string }): Promise<Map<string, T>> => {
      const entries = new Map<string, T>()
      for (const [key, value] of keyValues) {
        if (options?.prefix === undefined || key.startsWith(options.prefix)) {
          entries.set(key, value as T)
        }
      }
      return entries
    },

    setAlarm: async () => {},
    deleteAlarm: async () => {},
    getAlarm: async () => undefined,
    sync: () => {},
    close: () => db.close(),
  }
}
