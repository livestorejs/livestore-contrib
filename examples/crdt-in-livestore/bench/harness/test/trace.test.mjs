import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BLOCK_TYPES,
  EDIT_TAGS,
  POSITION_UNIT,
  assertLogicalEdit,
  codePointLength,
  utf8ByteLength,
} from '../src/model.mjs'
import { WORKLOAD_MATRIX, compileSchedule, generateTrace, summarizeTrace } from '../src/trace.mjs'

test('exposes the complete 27-cell workload matrix', () => {
  assert.equal(WORKLOAD_MATRIX.length, 27)
  assert.equal(new Set(WORKLOAD_MATRIX.map((workload) => workload.id)).size, 27)
  assert.deepEqual(new Set(WORKLOAD_MATRIX.map((workload) => workload.docSizeBytes)), new Set([2048, 20480, 204800]))
  assert.deepEqual(new Set(WORKLOAD_MATRIX.map((workload) => workload.editCount)), new Set([1000, 10000, 100000]))
  assert.deepEqual(new Set(WORKLOAD_MATRIX.map((workload) => workload.concurrency)), new Set([2, 3, 8]))
})

test('generates byte-for-byte repeatable traces without clock state', () => {
  const input = { seed: 'repeatable', docSizeBytes: 2048, editCount: 1000, concurrency: 3 }
  const first = generateTrace(input)
  const second = generateTrace(input)
  const different = generateTrace({ ...input, seed: 'different' })

  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.notEqual(JSON.stringify(first.operations), JSON.stringify(different.operations))
  assert.equal(first.positionUnit, POSITION_UNIT)
  assert.equal(utf8ByteLength(first.initialDocument.canonicalText), 2048)
  assert.ok(first.initialDocument.blocks.every((block) => Array.isArray(block.marks)))
  assert.equal(first.operations.length, 1000)
  assert.deepEqual(first.actorIds, ['actor-1', 'actor-2', 'actor-3'])
  assert.ok(first.offlineWindows.every((window) => window.endLogicalTick - window.startLogicalTick === window.durationLogicalEdits))
  assert.equal(JSON.stringify(first).includes('timestamp'), false)
  assert.equal(JSON.stringify(
    compileSchedule({ seed: first.seed, actorIds: first.actorIds, editCount: 1000, offlineWindows: first.offlineWindows }),
  ), JSON.stringify(
    compileSchedule({ seed: first.seed, actorIds: first.actorIds, editCount: 1000, offlineWindows: first.offlineWindows }),
  ))
})

test('uses a realistic exact operation mix and valid evolving code-point positions', () => {
  const trace = generateTrace({ seed: 'composition', docSizeBytes: 2048, editCount: 1000, concurrency: 2 })
  const summary = summarizeTrace(trace)

  assert.deepEqual(summary.counts, { typing: 700, delete: 150, markToggle: 100, paste: 50 })
  assert.ok(trace.operations.some(({ edit }) => edit._tag === 'setMark'))
  assert.ok(trace.operations.some(({ edit }) => edit._tag === 'unsetMark'))
  assert.ok(trace.operations.some(({ edit }) => edit._tag === 'insertText' && /[^\u0000-\u007f]/u.test(edit.text)))
  assert.equal(codePointLength('a🙂é'), 3)
})

test('validates the full rich-text tagged vocabulary including blocks', () => {
  const examples = [
    { _tag: 'insertText', blockId: 'a', offset: 0, text: 'x', origin: 'typing' },
    { _tag: 'deleteRange', blockId: 'a', start: 0, end: 1 },
    { _tag: 'setMark', blockId: 'a', start: 0, end: 1, key: 'bold', value: true },
    { _tag: 'unsetMark', blockId: 'a', start: 0, end: 1, key: 'bold' },
    { _tag: 'splitBlock', blockId: 'a', offset: 1, newBlockId: 'b' },
    { _tag: 'joinBlocks', blockId: 'a', nextBlockId: 'b' },
    { _tag: 'setBlockType', blockId: 'a', blockType: BLOCK_TYPES[1] },
  ]

  assert.deepEqual(examples.map((edit) => assertLogicalEdit(edit)._tag), EDIT_TAGS)
  assert.throws(() => assertLogicalEdit({ _tag: 'deleteRange', blockId: 'a', start: 1, end: 1 }), RangeError)
})

test('delivers every remote operation exactly once and in source order', () => {
  const trace = generateTrace({ seed: 'delivery', docSizeBytes: 2048, editCount: 1000, concurrency: 3 })
  const deliveries = new Map()
  const sequences = new Map()

  for (const event of trace.events.filter((event) => event._tag === 'sync')) {
    const sequenceKey = `${event.toActorId}<-${event.fromActorId}`
    const actorSequences = sequences.get(sequenceKey) ?? []
    for (const operationId of event.operationIds) {
      const key = `${event.toActorId}:${operationId}`
      deliveries.set(key, (deliveries.get(key) ?? 0) + 1)
      actorSequences.push(Number(operationId.split(':')[1]))
    }
    sequences.set(sequenceKey, actorSequences)
  }

  for (const operation of trace.operations) {
    for (const targetActorId of trace.actorIds.filter((actorId) => actorId !== operation.actorId)) {
      assert.equal(deliveries.get(`${targetActorId}:${operation.id}`), 1)
    }
  }
  for (const actorSequences of sequences.values()) {
    assert.deepEqual(actorSequences, actorSequences.toSorted((left, right) => left - right))
  }
})

test('omits offline delivery, records branch edits, and performs a final all-to-all drain', () => {
  const trace = generateTrace({
    seed: 'offline-branch',
    docSizeBytes: 2048,
    editCount: 1000,
    concurrency: 3,
    offlineBranchDurations: [30, 60],
  })

  for (const window of trace.offlineWindows) {
    const branchOperations = trace.operations.filter(
      (operation) =>
        operation.actorId === window.actorId &&
        operation.logicalTick >= window.startLogicalTick &&
        operation.logicalTick < window.endLogicalTick,
    )
    assert.ok(branchOperations.length > 0)
    const duringWindowSync = trace.events.filter(
      (event) =>
        event._tag === 'sync' &&
        event.logicalTick >= window.startLogicalTick &&
        event.logicalTick < window.endLogicalTick,
    )
    assert.ok(
      duringWindowSync.every(
        (event) => event.fromActorId !== window.actorId && event.toActorId !== window.actorId,
      ),
    )
  }

  const finalDrain = trace.events.filter((event) => event._tag === 'sync' && event.reason === 'final-drain')
  assert.equal(finalDrain.length, trace.actorIds.length * (trace.actorIds.length - 1))
  const operationCounts = Object.fromEntries(
    trace.actorIds.map((actorId) => [actorId, trace.operations.filter((operation) => operation.actorId === actorId).length]),
  )
  for (const targetActorId of trace.actorIds) {
    assert.deepEqual(trace.finalDeliveredFrontiers[targetActorId], operationCounts)
  }
})
