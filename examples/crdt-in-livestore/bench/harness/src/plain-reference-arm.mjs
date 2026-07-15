import { applyLogicalEdit, canonicalizeDocument } from './oracle.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Smoke/reference-only adapter. It establishes the harness contract but is not a
 * CRDT, does not merge concurrent edits, and must never contribute benchmark rows.
 */
export const plainReferenceArm = Object.freeze({
  id: 'plain-reference-smoke-only',
  benchmarkable: false,

  /** Creates the one setup state whose snapshot is shared by every replica. */
  bootstrap(_actorId, initialDocument) {
    return canonicalizeDocument(initialDocument)
  },

  applyLocal(state, edit) {
    return { state: applyLogicalEdit(state, edit), update: encoder.encode(JSON.stringify(edit)) }
  },

  applyRemote(state, update) {
    return applyLogicalEdit(state, JSON.parse(decoder.decode(update)))
  },

  canonicalize(state) {
    return canonicalizeDocument(state)
  },

  encodeSnapshot(state) {
    return encoder.encode(JSON.stringify(canonicalizeDocument(state)))
  },

  /** Restores the shared initial history; actor identity is irrelevant to this non-CRDT arm. */
  decodeSnapshot(snapshot, _actorId) {
    return canonicalizeDocument(JSON.parse(decoder.decode(snapshot)))
  },
})
