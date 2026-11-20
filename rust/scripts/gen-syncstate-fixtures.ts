/**
 * Runs the real TypeScript `merge` over hand-written and seeded random scenarios and dumps
 * input + output as JSON into `fixtures/syncstate/`. The Rust fixture runner replays them.
 *
 * Predicates used by every fixture (the Rust runner mirrors them):
 * - isClientOnlyEvent: `args.isClientOnly === true`
 * - isEqualEvent: `LiveStoreEvent.Client.isEqualEncoded`
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Cause, Effect, Exit } from '../../repos/livestore/packages/@livestore/utils/src/effect/mod.ts'

import * as EventSequenceNumber from '../../repos/livestore/packages/@livestore/common/src/schema/EventSequenceNumber/mod.ts'
import * as LiveStoreEvent from '../../repos/livestore/packages/@livestore/common/src/schema/LiveStoreEvent/mod.ts'
import * as SyncState from '../../repos/livestore/packages/@livestore/common/src/sync/syncstate.ts'

type Seq = EventSequenceNumber.Client.Composite
type Event = LiveStoreEvent.Client.Encoded
type Payload = typeof SyncState.Payload.Type

const outDir = path.join(import.meta.dirname, '..', 'fixtures', 'syncstate')

const main = () => {
  mkdirSync(outDir, { recursive: true })
  const handwritten = handwrittenCases()
  const random = randomCases(0x5eed, 400)
  write('handwritten.json', handwritten)
  write('random.json', random)
  const all = [...handwritten, ...random]
  const tally: Record<string, number> = {}
  for (const c of all) tally[(c.result as any)._tag] = (tally[(c.result as any)._tag] ?? 0) + 1
  console.log(`wrote ${all.length} fixtures`, tally)
}

const isClientOnlyEvent = (e: Event) =>
  typeof e.args === 'object' && e.args !== null && (e.args as any).isClientOnly === true

const runCase = (name: string, syncState: SyncState.SyncState, payload: Payload, ignoreClientOnlyEvents: boolean) => {
  const exit = Effect.runSyncExit(
    SyncState.merge({
      syncState,
      payload,
      isClientOnlyEvent,
      isEqualEvent: LiveStoreEvent.Client.isEqualEncoded,
      ignoreClientOnlyEvents,
    }),
  )
  const result = Exit.isSuccess(exit)
    ? plainResult(exit.value)
    : { _tag: 'die', message: dieMessage(exit.cause) }
  return { name, ignoreClientOnlyEvents, syncState: plainSyncState(syncState), payload: plainPayload(payload), result }
}

const dieMessage = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons.find(Cause.isDieReason)
  const defect = reason?.defect
  return defect instanceof Error ? defect.message : String(defect)
}

const ev = (seq: Seq, parent: Seq, payload: string, isClientOnly: boolean, clientId = 'static-local-id'): Event =>
  LiveStoreEvent.Client.Encoded.make({
    seqNum: seq,
    parentSeqNum: parent,
    name: 'a',
    args: { payload, isClientOnly },
    clientId,
    sessionId: 'static-session-id',
  })

const s = (global: number, client = 0, rebaseGeneration = 0): Seq => ({ global, client, rebaseGeneration }) as Seq

const ROOT = EventSequenceNumber.Client.ROOT

const state = (pending: Event[], upstreamHead: Seq, localHead: Seq) =>
  new SyncState.SyncState({ pending, upstreamHead, localHead })

const advance = (newEvents: Event[]): Payload => SyncState.PayloadUpstreamAdvance.make({ newEvents })
const push = (newEvents: Event[]): Payload => SyncState.PayloadLocalPush.make({ newEvents })
const rebase = (rollbackEvents: Event[], newEvents: Event[]): Payload =>
  SyncState.PayloadUpstreamRebase.make({ rollbackEvents, newEvents })

const handwrittenCases = () => {
  const e0_1 = ev(s(0, 1), ROOT, 'a', true)
  const e1_0 = ev(s(1), ROOT, 'a', false)
  const e1_1 = ev(s(1, 1), s(1), 'a', true)
  const e1_2 = ev(s(1, 2), s(1, 1), 'a', true)
  const e1_3 = ev(s(1, 3), s(1, 2), 'a', true)
  const e2_0 = ev(s(2), s(1), 'a', false)
  const e2_1 = ev(s(2, 1), s(2), 'a', true)
  const e1_0b = ev(s(1), s(1), '1_0_b', false)
  const e3_0 = ev(s(3), s(2), 'a', false)
  const e1_0r2 = ev(s(1, 0, 2), ROOT, 'a', false)
  const e2_0r2 = ev(s(2, 0, 2), s(1, 0, 2), 'a', false)

  const cases: Array<[string, SyncState.SyncState, Payload, boolean?]> = [
    // upstream-rebase
    ['rebase: rollback until start', state([e1_0, e1_1], ROOT, e1_1.seqNum), rebase([e1_0, e1_1], [e1_0b]), false],
    ['rebase: rollback to point', state([e1_1], e1_0.seqNum, e1_1.seqNum), rebase([e1_1], [e2_0]), false],
    ['rebase: empty pending', state([], ROOT, ROOT), rebase([], [e1_0b]), false],
    ['rebase: empty newEvents keeps upstream head', state([e1_0], ROOT, e1_0.seqNum), rebase([], [])],
    ['rebase: rebaseGeneration bump from r2 head', state([e1_0, e1_1], ROOT, e1_1.seqNum), rebase([], [e1_0r2, e2_0r2])],
    ['rebase: unsorted payload dies', state([], ROOT, ROOT), rebase([], [e2_0, e1_0])],
    // upstream-advance: advance
    ['advance: empty newEvents', state([e1_0], ROOT, e1_0.seqNum), advance([])],
    ['advance: unsorted client dies', state([e1_0], ROOT, e1_0.seqNum), advance([e1_2, e1_1])],
    ['advance: unsorted global dies', state([e1_0], ROOT, e1_0.seqNum), advance([e2_0, e1_0])],
    ['advance: incoming < upstream head dies', state([e2_1], e2_0.seqNum, e2_1.seqNum), advance([e1_0])],
    ['advance: incoming = upstream head dies', state([e2_1], e2_0.seqNum, e2_1.seqNum), advance([e2_0])],
    ['advance: confirm pending', state([e1_0], ROOT, e1_0.seqNum), advance([e1_0])],
    ['advance: confirm partial pending', state([e1_0, e1_1], ROOT, e1_1.seqNum), advance([e1_0])],
    ['advance: confirm pending and add new', state([e1_0], ROOT, e1_0.seqNum), advance([e1_0, e1_1])],
    ['advance: confirm pending and add many', state([e1_0], ROOT, e1_0.seqNum), advance([e1_0, e1_1, e1_2, e1_3, e2_0])],
    ['advance: confirm global keep client', state([e1_0, e1_1], ROOT, e1_1.seqNum), advance([e1_0])],
    ['advance: ignore client subset', state([e1_0, e1_1, e2_0], ROOT, e2_0.seqNum), advance([e1_0]), true],
    ['advance: ignore client subset 2', state([e1_0, e1_1, e2_0], ROOT, e2_0.seqNum), advance([e1_0, e2_0]), true],
    ['advance: ignore client beyond pending', state([e1_0, e1_1], ROOT, e1_1.seqNum), advance([e1_0, e2_0, e3_0]), true],
    ['advance: ignore client all client pending', state([e0_1], ROOT, e0_1.seqNum), advance([e1_0]), true],
    ['advance: no pending', state([], ROOT, ROOT), advance([e1_0, e2_0])],
    ['advance: localHead ahead of upstream w/o pending', state([], ROOT, s(1, 1)), advance([e1_0])],
    // upstream-advance: rebase
    ['advance-rebase: single event to end', state([e1_0], ROOT, e1_0.seqNum), advance([e1_1])],
    ['advance-rebase: different event same id', state([e1_0b], ROOT, e1_0b.seqNum), advance([e2_0])],
    ['advance-rebase: more incoming', state([e1_0], ROOT, e1_0.seqNum), advance([e1_1, e1_2, e1_3, e2_0])],
    ['advance-rebase: first matches', state([e1_0, e1_1], ROOT, e1_0.seqNum), advance([e1_0, e1_2, e1_3, e2_0])],
    ['advance-rebase: all differ', state([e1_0, e1_1], ROOT, e1_1.seqNum), advance([e1_1, e1_2, e1_3, e2_0])],
    ['advance-rebase: other client same seq', state([e1_0], ROOT, e1_0.seqNum), advance([ev(s(1), ROOT, 'a', false, 'other')])],
    ['advance-rebase: ignore client', state([e1_0, e1_1, e2_0], ROOT, e2_0.seqNum), advance([e1_0b]), true],
    ['advance-rebase: rebase gen r2 upstream', state([e1_0], ROOT, e1_0.seqNum), advance([e1_0r2, e2_0r2])],
    // local-push
    ['push: empty', state([e1_0], ROOT, e1_0.seqNum), push([])],
    ['push: advance', state([e1_0], ROOT, e1_0.seqNum), push([e1_1, e1_2, e1_3])],
    ['push: ignore client only', state([], ROOT, ROOT), push([e0_1]), true],
    ['push: ignore client keep global', state([], ROOT, ROOT), push([e0_1, e1_0]), true],
    ['push: reject', state([e1_0, e1_1], ROOT, e1_1.seqNum), push([e1_1, e1_2])],
    ['push: reject equal global', state([e1_0], ROOT, e1_0.seqNum), push([e1_0])],
    ['push: reject with rebase gen', state([], s(2, 0, 3), s(2, 0, 3)), push([e2_0])],
    ['push: unsorted dies', state([], ROOT, ROOT), push([e1_1, e1_0])],
    ['push: invalid pending chain dies', state([e1_0, ev(s(1, 2), s(1, 1), 'a', true)], ROOT, s(1, 2)), push([])],
    ['push: global pending with client != 0 dies', state([e1_0, ev(s(2, 1), s(1), 'a', true)], ROOT, s(2, 1)), push([])],
    ['push: pending unsorted dies', state([e2_0, e1_0], ROOT, s(2)), push([])],
    ['push: localHead lower than upstream after empty', state([], s(2), s(1)), push([e3_0])],
  ]
  return cases.map(([name, ss, p, ignore]) => runCase(name, ss, p, ignore ?? false))
}

/** Seeded random scenarios built from valid chains, mixing matching, divergent and out-of-range events. */
const randomCases = (seed: number, count: number) => {
  let x = seed
  const rnd = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return x / 0x7fffffff
  }
  const int = (n: number) => Math.floor(rnd() * n)
  const chain = (from: Seq, n: number, tag: string, gen?: number) => {
    const out: Event[] = []
    let head = from
    for (let i = 0; i < n; i++) {
      const clientOnly = rnd() < 0.35
      const pair = EventSequenceNumber.Client.nextPair({ seqNum: head, isClientOnly: clientOnly, rebaseGeneration: gen })
      out.push(ev(pair.seqNum, pair.parentSeqNum, `${tag}${i % 3}`, clientOnly, rnd() < 0.15 ? 'other' : 'static-local-id'))
      head = pair.seqNum
    }
    return out
  }

  const cases = []
  for (let i = 0; i < count; i++) {
    const upstreamHead = rnd() < 0.5 ? ROOT : s(int(3), 0, int(2))
    const pending = chain(upstreamHead, int(5), 'p')
    const localHead = pending.at(-1)?.seqNum ?? upstreamHead
    const ss = state(pending, upstreamHead, localHead)
    const ignore = rnd() < 0.5
    const kind = int(3)
    let payload: Payload
    if (kind === 0) {
      const keep = int(pending.length + 1)
      const prefix = pending.slice(0, keep)
      const rest = chain(prefix.at(-1)?.seqNum ?? upstreamHead, int(4), rnd() < 0.5 ? 'p' : 'u', rnd() < 0.2 ? int(3) : undefined)
      let events = [...prefix, ...rest]
      if (ignore && rnd() < 0.6) events = events.filter((e) => !isClientOnlyEvent(e))
      if (rnd() < 0.1) events = events.reverse()
      if (rnd() < 0.1) events = chain(s(int(2)), 1 + int(2), 'u')
      payload = advance(events)
    } else if (kind === 1) {
      const base = rnd() < 0.8 ? localHead : (pending[int(Math.max(pending.length, 1))]?.seqNum ?? ROOT)
      payload = push(chain(base, int(4), 'n'))
    } else {
      const base = rnd() < 0.5 ? upstreamHead : s(int(3), 0, int(3))
      payload = rebase(chain(ROOT, int(2), 'r'), chain(base, int(4), 'u', rnd() < 0.5 ? int(4) : undefined))
    }
    cases.push(runCase(`random-${i}`, ss, payload, ignore))
  }
  return cases
}

const write = (file: string, data: unknown) => writeFileSync(path.join(outDir, file), `${JSON.stringify(data, null, 1)}\n`)

const plainSeq = (q: Seq) => ({ global: q.global, client: q.client, rebaseGeneration: q.rebaseGeneration })
const plainEvent = (e: Event) => ({
  name: e.name,
  args: e.args,
  seqNum: plainSeq(e.seqNum),
  parentSeqNum: plainSeq(e.parentSeqNum),
  clientId: e.clientId,
  sessionId: e.sessionId,
})
const plainEvents = (es: ReadonlyArray<Event>) => es.map(plainEvent)
const plainSyncState = (ss: SyncState.SyncState) => ({
  pending: plainEvents(ss.pending),
  upstreamHead: plainSeq(ss.upstreamHead),
  localHead: plainSeq(ss.localHead),
})
const plainPayload = (p: Payload) =>
  p._tag === 'upstream-rebase'
    ? { _tag: p._tag, rollbackEvents: plainEvents(p.rollbackEvents), newEvents: plainEvents(p.newEvents) }
    : { _tag: p._tag, newEvents: plainEvents(p.newEvents) }
const plainResult = (r: typeof SyncState.MergeResult.Type) => {
  const mergeContext = { payload: plainPayload(r.mergeContext.payload), syncState: plainSyncState(r.mergeContext.syncState) }
  switch (r._tag) {
    case 'advance':
      return {
        _tag: r._tag,
        newSyncState: plainSyncState(r.newSyncState),
        newEvents: plainEvents(r.newEvents),
        confirmedEvents: plainEvents(r.confirmedEvents),
        mergeContext,
      }
    case 'rebase':
      return {
        _tag: r._tag,
        newSyncState: plainSyncState(r.newSyncState),
        newEvents: plainEvents(r.newEvents),
        rollbackEvents: plainEvents(r.rollbackEvents),
        mergeContext,
      }
    case 'reject':
      return { _tag: r._tag, expectedMinimumId: plainSeq(r.expectedMinimumId), mergeContext }
  }
}

main()
