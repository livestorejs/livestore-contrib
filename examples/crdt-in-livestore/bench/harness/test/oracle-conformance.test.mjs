import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONFORMANCE_SUITE_HASH,
  CONFORMANCE_SUITE_ID,
  CONFORMANCE_SUITE_VERSION,
  ConformanceError,
  runConformanceSuite,
} from '../src/conformance.mjs'
import { applyLogicalEdit, canonicalizeDocument } from '../src/oracle.mjs'
import { plainReferenceArm } from '../src/plain-reference-arm.mjs'

describe('semantic rich-text oracle', () => {
  it('uses Unicode code-point positions for evolving inserts and deletes', () => {
    const initial = { blocks: [{ id: 'p', type: 'paragraph', text: 'A🌍B', marks: [] }] }
    const inserted = applyLogicalEdit(initial, {
      _tag: 'insertText',
      blockId: 'p',
      offset: 2,
      text: '🦊',
      origin: 'typing',
    })
    const deleted = applyLogicalEdit(inserted, {
      _tag: 'deleteRange',
      blockId: 'p',
      start: 1,
      end: 3,
    })
    assert.equal(deleted.blocks[0].text, 'AB')
  })

  it('splits overlapping mark values and coalesces equal adjacent spans', () => {
    const initial = {
      blocks: [{ id: 'p', type: 'paragraph', text: 'abcdefghij', marks: [] }],
    }
    const first = applyLogicalEdit(initial, {
      _tag: 'setMark', blockId: 'p', start: 0, end: 8, key: 'link', value: 'a',
    })
    const overlap = applyLogicalEdit(first, {
      _tag: 'setMark', blockId: 'p', start: 3, end: 6, key: 'link', value: 'b',
    })
    assert.deepEqual(overlap.blocks[0].marks, [
      { start: 0, end: 3, key: 'link', value: 'a' },
      { start: 6, end: 8, key: 'link', value: 'a' },
      { start: 3, end: 6, key: 'link', value: 'b' },
    ].sort(markOrder))

    const restored = applyLogicalEdit(overlap, {
      _tag: 'setMark', blockId: 'p', start: 3, end: 6, key: 'link', value: 'a',
    })
    assert.deepEqual(restored.blocks[0].marks, [{ start: 0, end: 8, key: 'link', value: 'a' }])
  })

  it('preserves crossing marks through split and join', () => {
    const initial = {
      blocks: [{ id: 'p', type: 'paragraph', text: 'abcdef', marks: [{ start: 1, end: 5, key: 'bold', value: true }] }],
    }
    const split = applyLogicalEdit(initial, {
      _tag: 'splitBlock', blockId: 'p', offset: 3, newBlockId: 'q',
    })
    assert.deepEqual(split.blocks.map((block) => [block.text, block.marks]), [
      ['abc', [{ start: 1, end: 3, key: 'bold', value: true }]],
      ['def', [{ start: 0, end: 2, key: 'bold', value: true }]],
    ])
    const joined = applyLogicalEdit(split, { _tag: 'joinBlocks', blockId: 'p', nextBlockId: 'q' })
    assert.deepEqual(joined, canonicalizeDocument(initial))
  })
})

describe('arm conformance gate', () => {
  it('admits the non-benchmarkable plain reference arm', async () => {
    const report = await runConformanceSuite(plainReferenceArm)
    assert.equal(report.passed, true)
    assert.equal(report.editCount, 13)
    assert.equal(report.scenarioCount, 13)
    assert.deepEqual(report.suite, {
      id: CONFORMANCE_SUITE_ID,
      version: CONFORMANCE_SUITE_VERSION,
      hash: CONFORMANCE_SUITE_HASH,
    })
    assert.equal(CONFORMANCE_SUITE_ID, 'livestore-rich-text-conformance-v1')
    assert.equal(CONFORMANCE_SUITE_VERSION, '1.0.0')
    assert.equal(CONFORMANCE_SUITE_HASH, 'sha256:bacb078d5a4517d277d09ef7910a7c018ff9f03c99e629cb2025ce6836ff3ea1')
    assert.equal(plainReferenceArm.benchmarkable, false)
  })

  it('rejects an adapter that drops remote updates', async () => {
    const faultyArm = { ...plainReferenceArm, id: 'deliberately-faulty', applyRemote: (state) => state }
    await assert.rejects(() => runConformanceSuite(faultyArm), (error) => {
      assert.ok(error instanceof ConformanceError)
      assert.match(error.stage, /^remote replay 0/)
      return true
    })
  })

  it('rejects replica initialization that does not restore the shared bootstrap history', async () => {
    const faultyArm = {
      ...plainReferenceArm,
      id: 'independent-history-fault',
      decodeSnapshot: (_snapshot, actorId) => ({
        blocks: [{ id: `independent-${actorId}`, type: 'paragraph', text: '', marks: [] }],
      }),
    }
    await assert.rejects(() => runConformanceSuite(faultyArm), (error) => {
      assert.ok(error instanceof ConformanceError)
      assert.equal(error.stage, 'local shared-history initialization')
      return true
    })
  })
})

const markOrder = (left, right) =>
  left.key.localeCompare(right.key) ||
  JSON.stringify(left.value).localeCompare(JSON.stringify(right.value)) ||
  left.start - right.start ||
  left.end - right.end
