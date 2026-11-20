// Speaks the wire protocol by hand (like a Rust client would) to capture edge cases.
// Usage: node capture-raw.mjs <wsBase> <outDir>
import { writeFileSync } from 'node:fs'

const [wsBase = 'ws://localhost:8787', outDir = '.'] = process.argv.slice(2)
const run = Date.now()

const session = async (name, storeId, script, query = `storeId=${storeId}&transport=ws`) => {
  const url = `${wsBase}/?${query}`
  const frames = [{ dir: 'open', url }]
  const ws = new WebSocket(url)
  const inbox = []
  let waiter
  ws.addEventListener('message', (e) => {
    frames.push({ dir: 'server->client', raw: e.data, json: JSON.parse(e.data) })
    inbox.push(JSON.parse(e.data))
    waiter?.()
  })
  ws.addEventListener('close', (e) => {
    frames.push({ dir: 'close', code: e.code, reason: e.reason })
    waiter?.()
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = (msg) => {
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg)
    frames.push({ dir: 'client->server', raw, json: typeof msg === 'string' ? undefined : msg })
    ws.send(raw)
  }
  /** wait until predicate matches a new message or timeout; returns matched message or undefined */
  const recv = async (pred = () => true, ms = 1500) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const i = inbox.findIndex(pred)
      if (i >= 0) return inbox.splice(i, 1)[0]
      await new Promise((r) => {
        waiter = r
        setTimeout(r, Math.max(0, deadline - Date.now()))
      })
    }
    return undefined
  }
  const drain = async (ms) => {
    await new Promise((r) => setTimeout(r, ms))
    return inbox.splice(0)
  }
  try {
    await script({ send, recv, drain })
  } finally {
    ws.close()
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(`${outDir}/${name}.json`, JSON.stringify(frames, null, 2))
    console.log(`${name}: ${frames.length} frames`)
  }
}

const ev = (seq, i = seq) => ({
  name: 'todoCreated-v1',
  args: { id: `todo-${seq}`, text: `Todo ${i}` },
  seqNum: seq,
  parentSeqNum: seq - 1,
  clientId: 'rust-client',
  sessionId: 'rust-session',
})
const pullReq = (id, storeId, cursor, live) => ({
  _tag: 'Request',
  id,
  tag: 'SyncWsRpc.Pull',
  payload: { storeId, live, cursor: cursor ? { _tag: 'Some', value: cursor } : { _tag: 'None' } },
  headers: [],
})
const pushReq = (id, storeId, batch, backendId) => ({
  _tag: 'Request',
  id,
  tag: 'SyncWsRpc.Push',
  payload: { storeId, batch, backendId: backendId ? { _tag: 'Some', value: backendId } : { _tag: 'None' } },
  headers: [],
})

// 1) ping/pong (DO auto-response, works even while hibernated)
await session('ping-pong', `raw-${run}-ping`, async ({ send, recv }) => {
  send({ _tag: 'Ping' })
  await recv((m) => m._tag === 'Pong')
})

// 2) minimal push with backendId None + pull-initial with pagination (250 events -> 3 chunks)
const big = `raw-${run}-big`
let backendId
await session('push-minimal-and-paginated-pull', big, async ({ send, recv, drain }) => {
  for (let start = 1; start <= 250; start += 100) {
    const id = `push-${start}`
    const batch = Array.from({ length: Math.min(100, 251 - start) }, (_, k) => ev(start + k))
    send(pushReq(id, big, batch, undefined))
    await recv((m) => m.requestId === id && m._tag === 'Exit')
  }
  // Non-live pull, NO Acks sent: does the server wait for Ack between chunks?
  send(pullReq(10, big, undefined, false))
  const noAck = await drain(1500)
  console.log('chunks without ack:', noAck.map((m) => m._tag + ':' + (m.values?.[0]?.batch.length ?? '')))
  backendId = noAck.find((m) => m._tag === 'Chunk')?.values[0].backendId
  for (const m of noAck) if (m._tag === 'Chunk') send({ _tag: 'Ack', requestId: m.requestId })
  // Ack every further chunk until the terminal Exit arrives
  for (;;) {
    const m = await recv((x) => x.requestId === 10)
    if (m === undefined || m._tag === 'Exit') break
    send({ _tag: 'Ack', requestId: 10 })
  }
})

// 3) pull from cursor (incremental) + live update from another connection
await session('pull-live-update', big, async ({ send, recv, drain }) => {
  send(pullReq('live-1', big, { backendId, eventSequenceNumber: 249 }, true))
  const first = await recv((m) => m._tag === 'Chunk')
  send({ _tag: 'Ack', requestId: first.requestId })
  await session('push-from-other-connection', big, async (other) => {
    other.send(pushReq(1, big, [ev(251)], backendId))
    await other.recv((m) => m._tag === 'Exit')
  })
  const live = await recv((m) => m._tag === 'Chunk')
  if (live) send({ _tag: 'Ack', requestId: live.requestId })
  send({ _tag: 'Interrupt', requestId: 'live-1' })
  await drain(800)
})

// 4) errors
await session('error-server-ahead', big, async ({ send, recv }) => {
  send(pushReq(1, big, [ev(5)], backendId))
  await recv((m) => m._tag === 'Exit')
})
await session('error-backend-id-mismatch', big, async ({ send, recv }) => {
  send(pushReq(1, big, [ev(252)], 'wrong-backend-id'))
  await recv((m) => m._tag === 'Exit')
  send(pullReq(2, big, { backendId: 'wrong-backend-id', eventSequenceNumber: 3 }, false))
  await recv((m) => m._tag === 'Exit')
})
await session('error-malformed', big, async ({ send, drain }) => {
  send({ _tag: 'Request', id: 1, tag: 'SyncWsRpc.Pull', payload: { storeId: big }, headers: [] })
  await drain(800)
  send({ _tag: 'Request', id: 2, tag: 'SyncWsRpc.Nope', payload: {}, headers: [] })
  await drain(800)
  send('not json')
  await drain(800)
})
// 5) payload query param + event with null/nested args, and an Eof frame
await session(
  'payload-query-param',
  `raw-${run}-payload`,
  async ({ send, recv }) => {
    send(pushReq(1, `raw-${run}-payload`, [{ ...ev(1), args: { nested: { a: [1, null, 'x'] }, n: null } }]))
    await recv((m) => m._tag === 'Exit')
  },
  `storeId=raw-${run}-payload&payload=${encodeURIComponent(encodeURIComponent(JSON.stringify({ authToken: 'insecure-token' })))}&transport=ws`,
)
process.exit(0)
