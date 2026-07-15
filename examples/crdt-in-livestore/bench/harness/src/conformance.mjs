import { createHash } from 'node:crypto'

import { BLOCK_TYPES } from './model.mjs'
import { applyLogicalEdit, canonicalizeDocument, documentsEqual } from './oracle.mjs'

export const CONFORMANCE_SUITE_ID = 'livestore-rich-text-conformance-v1'
export const CONFORMANCE_SUITE_VERSION = '1.0.0'

/**
 * Runs the semantic admission gate shared by every benchmark arm.
 *
 * RichTextArm contract:
 * bootstrap(actorId, initialDocument) -> state
 * applyLocal(state, LogicalEdit) -> { state, update: Uint8Array }
 * applyRemote(state, update) -> state
 * canonicalize(state) -> CanonicalDocument
 * encodeSnapshot(state) -> Uint8Array
 * decodeSnapshot(snapshot, actorId) -> state
 *
 * Every editing replica must decode the same bootstrap snapshot. This gives real
 * CRDT adapters a shared initial history instead of independently-created roots.
 * All methods may return their value directly or as a Promise.
 */
export const runConformanceSuite = async (arm) => {
  assertArmShape(arm)
  const initial = conformanceInitialDocument()
  const edits = conformanceEdits()
  let expected = canonicalizeDocument(initial)
  const bootstrapState = await arm.bootstrap('conformance-bootstrap', initial)
  assertSemanticMatch(await arm.canonicalize(bootstrapState), expected, 'bootstrap')
  const bootstrapSnapshot = await arm.encodeSnapshot(bootstrapState)
  if (!(bootstrapSnapshot instanceof Uint8Array)) throw new TypeError('encodeSnapshot must return Uint8Array')

  let localState = await arm.decodeSnapshot(bootstrapSnapshot, 'conformance-local')
  let remoteState = await arm.decodeSnapshot(bootstrapSnapshot, 'conformance-remote')
  assertSemanticMatch(await arm.canonicalize(localState), expected, 'local shared-history initialization')
  assertSemanticMatch(await arm.canonicalize(remoteState), expected, 'remote shared-history initialization')

  for (const [index, edit] of edits.entries()) {
    expected = applyLogicalEdit(expected, edit)
    const local = await arm.applyLocal(localState, edit)
    assertUpdate(local, index)
    localState = local.state
    assertSemanticMatch(await arm.canonicalize(localState), expected, `local edit ${index} (${edit._tag})`)

    remoteState = await arm.applyRemote(remoteState, local.update)
    assertSemanticMatch(await arm.canonicalize(remoteState), expected, `remote replay ${index} (${edit._tag})`)
  }

  const snapshot = await arm.encodeSnapshot(localState)
  if (!(snapshot instanceof Uint8Array)) throw new TypeError('encodeSnapshot must return Uint8Array')
  const restored = await arm.decodeSnapshot(snapshot, 'conformance-restored')
  assertSemanticMatch(await arm.canonicalize(restored), expected, 'snapshot round trip')

  return Object.freeze({
    armId: arm.id,
    passed: true,
    suite: Object.freeze({
      id: CONFORMANCE_SUITE_ID,
      version: CONFORMANCE_SUITE_VERSION,
      hash: CONFORMANCE_SUITE_HASH,
    }),
    scenarioCount: edits.length,
    editCount: edits.length,
    snapshotBytes: snapshot.byteLength,
    canonical: expected,
  })
}

export const conformanceInitialDocument = () => ({
  blocks: [
    {
      id: 'paragraph-1',
      type: 'paragraph',
      text: 'Alpha 🌍 beta',
      marks: [{ start: 0, end: 5, key: 'bold', value: true }],
    },
    { id: 'paragraph-2', type: 'paragraph', text: 'Second block', marks: [] },
  ],
})

/** Covers typing/paste, evolving deletes, overlapping mark replacement, and block edits. */
export const conformanceEdits = () => [
  { _tag: 'insertText', blockId: 'paragraph-1', offset: 6, text: 'bright ', origin: 'typing' },
  { _tag: 'insertText', blockId: 'paragraph-1', offset: 13, text: '🦊', origin: 'paste' },
  { _tag: 'deleteRange', blockId: 'paragraph-1', start: 5, end: 7 },
  { _tag: 'setMark', blockId: 'paragraph-1', start: 0, end: 10, key: 'italic', value: true },
  { _tag: 'setMark', blockId: 'paragraph-1', start: 4, end: 14, key: 'bold', value: true },
  { _tag: 'unsetMark', blockId: 'paragraph-1', start: 7, end: 12, key: 'bold' },
  { _tag: 'setMark', blockId: 'paragraph-1', start: 2, end: 8, key: 'link', value: 'https://example.test' },
  { _tag: 'setMark', blockId: 'paragraph-1', start: 5, end: 11, key: 'link', value: 'https://example.test/next' },
  { _tag: 'splitBlock', blockId: 'paragraph-1', offset: 9, newBlockId: 'paragraph-split' },
  {
    _tag: 'setBlockType',
    blockId: 'paragraph-split',
    blockType: pickAlternateBlockType(),
  },
  { _tag: 'insertText', blockId: 'paragraph-split', offset: 0, text: 'continued ', origin: 'typing' },
  { _tag: 'joinBlocks', blockId: 'paragraph-1', nextBlockId: 'paragraph-split' },
  { _tag: 'deleteRange', blockId: 'paragraph-2', start: 0, end: 7 },
]

/** SHA-256 identity of the canonical initial document and ordered semantic scenarios. */
export const CONFORMANCE_SUITE_HASH = `sha256:${createHash('sha256')
  .update(
    JSON.stringify({
      version: CONFORMANCE_SUITE_VERSION,
      initial: canonicalizeDocument(conformanceInitialDocument()),
      edits: conformanceEdits(),
    }),
  )
  .digest('hex')}`

export class ConformanceError extends Error {
  constructor(stage, actual, expected) {
    super(`Rich-text conformance failed at ${stage}`)
    this.name = 'ConformanceError'
    this.stage = stage
    this.actual = canonicalizeDocument(actual)
    this.expected = canonicalizeDocument(expected)
  }
}

const assertSemanticMatch = (actual, expected, stage) => {
  if (!documentsEqual(actual, expected)) throw new ConformanceError(stage, actual, expected)
}

const assertUpdate = (result, index) => {
  if (result === null || typeof result !== 'object' || !('state' in result)) {
    throw new TypeError(`applyLocal result ${index} must contain state`)
  }
  if (!(result.update instanceof Uint8Array)) {
    throw new TypeError(`applyLocal result ${index} update must be Uint8Array`)
  }
}

const assertArmShape = (arm) => {
  for (const method of ['bootstrap', 'applyLocal', 'applyRemote', 'canonicalize', 'encodeSnapshot', 'decodeSnapshot']) {
    if (typeof arm?.[method] !== 'function') throw new TypeError(`RichTextArm.${method} must be a function`)
  }
}

function pickAlternateBlockType() {
  const types = Array.from(BLOCK_TYPES)
  return types.find((type) => type !== 'paragraph') ?? 'paragraph'
}
