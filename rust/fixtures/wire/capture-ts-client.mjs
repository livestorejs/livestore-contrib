// Drives the real TS `makeWsSync` client against a local sync backend and records every WS frame.
// Usage: node capture-ts-client.mjs <baseUrl> <storeId> <outFile>
import { writeFileSync } from 'node:fs'

const [baseUrl = 'http://localhost:8787', storeId = `capture-${Date.now()}`, outFile = 'ts-client-session.json'] =
  process.argv.slice(2)
const repo = new URL('../../../repos/livestore/', import.meta.url).pathname
const frames = []
const t0 = Date.now()
const log = (dir, data) => {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  frames.push({ t: Date.now() - t0, dir, raw: text, json })
}

const NativeWS = globalThis.WebSocket
globalThis.WebSocket = class extends NativeWS {
  constructor(url, protocols) {
    super(url, protocols)
    frames.push({ t: Date.now() - t0, dir: 'open', url: String(url) })
    this.addEventListener('message', (e) => log('server->client', e.data))
  }
  send(data) {
    log('client->server', data)
    return super.send(data)
  }
}

const { makeWsSync } = await import(`${repo}packages/@livestore/sync-cf/src/client/mod.ts`)
const { Effect, Option, Stream, Fiber, KeyValueStore, FetchHttpClient } = await import(
  `${repo}packages/@livestore/utils/src/effect/mod.ts`
)

const ev = (seq, parent, i) => ({
  name: 'todoCreated-v1',
  args: { id: `todo-${seq}`, text: `Todo ${i}` },
  seqNum: seq,
  parentSeqNum: parent,
  clientId: 'ts-client',
  sessionId: 'ts-session',
})

const program = Effect.gen(function* () {
  const backend = yield* makeWsSync({ url: baseUrl })({ storeId, clientId: 'ts-client', payload: { authToken: 'insecure-token' } })
  yield* backend.connect
  // initial pull on empty store (non-live)
  const empty = yield* backend.pull(Option.none()).pipe(Stream.runCollect)
  // start a live pull from scratch in background
  const live = yield* backend.pull(Option.none(), { live: true }).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
  yield* Effect.sleep('300 millis')
  yield* backend.push([ev(1, 0, 1), ev(2, 1, 2)])
  yield* backend.push([ev(3, 2, 3)])
  const liveRes = yield* Fiber.join(live)
  // pull with cursor
  const fromCursor = yield* backend
    .pull(Option.some({ eventSequenceNumber: 1, clientSeq: 0, rebaseGeneration: 0 }))
    .pipe(Stream.runCollect)
  // a stale push -> ServerAheadError
  const stale = yield* backend.push([ev(2, 1, 99)]).pipe(Effect.flip)
  yield* backend.ping
  return { empty, liveRes, fromCursor, stale: stale._tag }
}).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory), Effect.provide(FetchHttpClient.layer))

try {
  const res = await Effect.runPromise(program)
  console.log(JSON.stringify(res, null, 1).slice(0, 2000))
} catch (e) {
  console.error('program failed', e)
}
writeFileSync(outFile, JSON.stringify(frames, null, 2))
console.log(`wrote ${frames.length} frames to ${outFile}`)
process.exit(0)
