import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Schema } from 'effect'

export class ActionAuthorityUnavailable extends Schema.TaggedError<ActionAuthorityUnavailable>()(
  'ActionAuthorityUnavailable',
  { path: Schema.String, message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface ActionAuthorityLock {
  readonly path: string
}

/**
 * Holds an SQLite EXCLUSIVE transaction for the process lifetime. The OS drops
 * the lock on crash, avoiding stale PID-file authority and split-brain writes.
 */
export const acquireActionAuthority = (stateDirectory: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
        const path = join(stateDirectory, 'action-authority.sqlite')
        const database = new DatabaseSync(path)
        try {
          database.exec('PRAGMA busy_timeout = 0')
          database.exec('CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK (id = 1)) STRICT')
          database.exec('BEGIN EXCLUSIVE')
          database.prepare('INSERT OR IGNORE INTO authority (id) VALUES (1)').run()
          return { database, lock: { path } satisfies ActionAuthorityLock }
        } catch (cause) {
          database.close()
          throw cause
        }
      },
      catch: (cause) =>
        new ActionAuthorityUnavailable({
          path: join(stateDirectory, 'action-authority.sqlite'),
          message: 'Another process owns Action Authority or the lock cannot be opened',
          cause,
        }),
    }),
    ({ database }) =>
      Effect.sync(() => {
        try {
          database.exec('ROLLBACK')
        } finally {
          database.close()
        }
      }),
  ).pipe(
    Effect.map(({ lock }) => lock),
    Effect.withSpan('runtime.actionAuthority.acquire'),
  )
