import assert from 'node:assert/strict'
import test from 'node:test'

import { runConformanceSuite } from '../harness/src/conformance.mjs'
import {
  decodeLiveStoreEvent,
  embeddedArm,
  encodeLiveStoreEvent,
  standaloneArm,
} from './loro-arm.mjs'

test('standalone passes the shared rich-text conformance gate', async () => {
  const report = await runConformanceSuite(standaloneArm)
  assert.equal(report.passed, true)
  assert.equal(report.scenarioCount, 13)
})

test('embedded passes the shared rich-text conformance gate', async () => {
  const report = await runConformanceSuite(embeddedArm)
  assert.equal(report.passed, true)
  assert.equal(report.scenarioCount, 13)
})

test('translates Unicode code-point offsets without splitting surrogate pairs', async () => {
  let state = standaloneArm.bootstrap('unicode', {
    blocks: [{ id: 'a', type: 'paragraph', text: 'A🌍B', marks: [] }],
  })
  state = (await standaloneArm.applyLocal(state, {
    _tag: 'insertText',
    blockId: 'a',
    offset: 2,
    text: '🦊',
    origin: 'typing',
  })).state
  assert.equal((await standaloneArm.canonicalize(state)).blocks[0].text, 'A🌍🦊B')
})

test('boundary insert does not inherit a latent wider mark after a partial unmark', async () => {
  for (const arm of [standaloneArm, embeddedArm]) {
    let state = arm.bootstrap(`${arm.id}-latent-mark`, {
      blocks: [{ id: 'a', type: 'paragraph', text: 'abcd', marks: [] }],
    })
    state = (await arm.applyLocal(state, {
      _tag: 'setMark',
      blockId: 'a',
      start: 0,
      end: 3,
      key: 'code',
      value: true,
    })).state
    state = (await arm.applyLocal(state, {
      _tag: 'unsetMark',
      blockId: 'a',
      start: 1,
      end: 3,
      key: 'code',
    })).state
    state = (await arm.applyLocal(state, {
      _tag: 'insertText',
      blockId: 'a',
      offset: 1,
      text: 'X',
      origin: 'typing',
    })).state

    assert.deepEqual((await arm.canonicalize(state)).blocks[0], {
      id: 'a',
      type: 'paragraph',
      text: 'aXbcd',
      marks: [{ start: 0, end: 1, key: 'code', value: true }],
    })
    arm.release(state)
  }
})

test('embedded event carries the exact native update and records a real materializer hash', async () => {
  const nativeUpdate = Uint8Array.of(0, 1, 2, 127, 128, 255)
  const encoded = encodeLiveStoreEvent({ actorId: 'actor', sequence: 7, nativeUpdate })
  const decoded = decodeLiveStoreEvent(encoded.bytes)
  assert.deepEqual(decoded.nativeUpdate, nativeUpdate)
  assert.equal(decoded.event.args.updateBase64, Buffer.from(nativeUpdate).toString('base64'))

  let state = embeddedArm.bootstrap('actor', {
    blocks: [{ id: 'a', type: 'paragraph', text: 'A', marks: [] }],
  })
  const local = await embeddedArm.applyLocal(state, {
    _tag: 'insertText',
    blockId: 'a',
    offset: 1,
    text: 'B',
    origin: 'typing',
  })
  state = local.state
  assert.equal(state.events.length, 1)
  assert.equal(state.materializerHashes.length, 1)
  assert.equal(typeof state.materializerHashes[0], 'number')
  assert.ok(state.eventBytes > state.nativeBytes)
})

test('history hooks measure each post-bootstrap logical operation update exactly once', async () => {
  const initial = {
    blocks: [{ id: 'a', type: 'paragraph', text: 'A', marks: [] }],
  }
  const edit = {
    _tag: 'insertText',
    blockId: 'a',
    offset: 1,
    text: 'B',
    origin: 'typing',
  }
  const standaloneBootstrap = standaloneArm.bootstrap('standalone-history', initial)
  const standaloneBootstrapBytes = standaloneArm.encodeSnapshot(standaloneBootstrap).byteLength
  const standaloneUpdate = (await standaloneArm.applyLocal(standaloneBootstrap, edit)).update
  const embeddedBootstrap = embeddedArm.bootstrap('embedded-history', initial)
  const embeddedBootstrapBytes = embeddedArm.encodeSnapshot(embeddedBootstrap).byteLength
  assert.equal(
    standaloneArm.historyBytes({
      execution: { states: new Map([['standalone-history', standaloneBootstrap]]), updates: new Map() },
    }),
    0,
  )
  assert.equal(
    embeddedArm.historyBytes({
      execution: { states: new Map([['embedded-history', embeddedBootstrap]]), updates: new Map() },
    }),
    0,
  )
  const embeddedUpdate = (await embeddedArm.applyLocal(embeddedBootstrap, edit)).update
  const standaloneUpdate2 = (
    await standaloneArm.applyLocal(standaloneBootstrap, { ...edit, offset: 2, text: 'C' })
  ).update
  const embeddedUpdate2 = (await embeddedArm.applyLocal(embeddedBootstrap, { ...edit, offset: 2, text: 'C' })).update

  assert.equal(
    standaloneArm.historyBytes({
      execution: { updates: new Map([['op-1', standaloneUpdate], ['op-2', standaloneUpdate2]]) },
    }),
    standaloneUpdate.byteLength + standaloneUpdate2.byteLength,
  )
  assert.equal(
    embeddedArm.historyBytes({
      execution: { updates: new Map([['op-1', embeddedUpdate], ['op-2', embeddedUpdate2]]) },
    }),
    embeddedUpdate.byteLength + embeddedUpdate2.byteLength,
  )
  assert.notEqual(standaloneUpdate.byteLength, standaloneBootstrapBytes)
  assert.notEqual(embeddedUpdate.byteLength, embeddedBootstrapBytes)
})
