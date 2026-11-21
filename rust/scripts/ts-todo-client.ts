/**
 * Headless TypeScript LiveStore client (in-memory adapter + sync-cf WS) using the TodoMVC example schema.
 * Driven line by line over stdin; answers on stdout with one JSON line per command.
 *
 *   bun scripts/ts-todo-client.ts <wsUrl> <storeId>
 *   commit <eventName> <argsJson>   → {"ok":true}
 *   rows                            → {"rows":[...],"status":{...}}   (todos ordered by id, raw SQLite values)
 *   quit
 */
import { createInterface } from 'node:readline'

import { makeInMemoryAdapter } from '../../repos/livestore/packages/@livestore/adapter-web/src/index.ts'
import { createStorePromise } from '../../repos/livestore/packages/@livestore/livestore/src/mod.ts'
import { makeWsSync } from '../../repos/livestore/packages/@livestore/sync-cf/src/client/mod.ts'

// The core example is not installed in contrib, so scripts/test-live.sh stages its schema next to package links.
const { events, schema } = await import(
  process.env.LIVESTORE_TODOMVC_SCHEMA ?? '../../repos/livestore/examples/web-todomvc-sync-cf/src/livestore/schema.ts'
)

// stdout carries only replies; some core versions log to it.
console.log = console.error
console.info = console.error
console.debug = console.error

const [url, storeId] = process.argv.slice(2)
if (url === undefined || storeId === undefined) throw new Error('usage: ts-todo-client.ts <wsUrl> <storeId>')

const store = await createStorePromise({
  schema,
  storeId,
  adapter: makeInMemoryAdapter({
    sync: { backend: makeWsSync({ url }), initialSyncOptions: { _tag: 'Blocking', timeout: 5000 } },
    clientId: 'ts-client',
    sessionId: 'ts-session',
  }),
  syncPayload: { authToken: 'insecure-token-change-me' },
  disableDevtools: true,
})

const byName = Object.fromEntries(Object.values(events).map((def) => [def.name, def]))
const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
reply({ ready: true })

for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, name, ...rest] = line.trim().split(' ')
  if (cmd === 'quit') break
  if (cmd === 'commit' && name !== undefined) {
    const args = JSON.parse(rest.join(' '))
    if (args.deletedAt !== undefined) args.deletedAt = new Date(args.deletedAt)
    store.commit((byName[name] as any)(args))
    reply({ ok: true })
  } else if (cmd === 'rows') {
    reply({ rows: store.query({ query: 'SELECT id, text, completed, deletedAt FROM todos ORDER BY id', bindValues: {} }), status: store.syncStatus() })
  } else {
    reply({ error: `unknown command: ${line}` })
  }
}

await store.shutdownPromise()
process.exit(0)
