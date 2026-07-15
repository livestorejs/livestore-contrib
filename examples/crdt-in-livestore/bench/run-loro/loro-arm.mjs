import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { canonicalizeDocument } from '../harness/src/oracle.mjs'

const require = createRequire(import.meta.url)
const { LoroDoc } = require('loro-crdt')

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const documentId = 'loro-benchmark-document'
const materializerSql =
  'INSERT INTO crdt_updates (doc_id, update_id, update_bytes_base64) VALUES (?, ?, ?)'

const hashMaterializerResults = (results) => createHash('sha256').update(JSON.stringify(results)).digest().readInt32BE(0)
const textStyle = Object.freeze({
  bold: { expand: 'none' },
  italic: { expand: 'none' },
  underline: { expand: 'none' },
  code: { expand: 'none' },
  link: { expand: 'none' },
})

const commonMetadata = Object.freeze({
  technology: 'loro',
  crdtName: 'loro',
  crdtVersion: '1.13.6',
  libraryVersion: '1.13.6',
})

export const standaloneArm = makeArm({ embedded: false })
export const embeddedArm = makeArm({ embedded: true })

/** The event serializer is exported so the runner can label the exact measured wire protocol. */
export const encodeLiveStoreEvent = ({ actorId, sequence, nativeUpdate }) => {
  const updateBase64 = Buffer.from(nativeUpdate).toString('base64')
  const updateId = `${actorId}:${sequence}`
  const event = {
    name: 'LoroUpdate',
    args: { docId: documentId, updateId, updateBase64 },
  }
  return { bytes: encoder.encode(JSON.stringify(event)), event, updateBase64, updateId }
}

/** Returns the exact native bytes carried by an embedded event. */
export const decodeLiveStoreEvent = (bytes) => {
  const event = JSON.parse(decoder.decode(bytes))
  if (
    event?.name !== 'LoroUpdate' ||
    event.args?.docId !== documentId ||
    typeof event.args?.updateId !== 'string' ||
    typeof event.args?.updateBase64 !== 'string'
  ) {
    throw new TypeError('Invalid LoroUpdate LiveStore event')
  }
  return { event, nativeUpdate: Uint8Array.from(Buffer.from(event.args.updateBase64, 'base64')) }
}

function makeArm({ embedded }) {
  const benchmarkMetadata = Object.freeze({
    ...commonMetadata,
    axis: embedded ? 'embedded' : 'standalone',
    wireProtocol: Object.freeze(
      embedded
        ? {
            boundary: 'LiveStore JSON event',
            encoding: 'RFC 4648 base64 of exact native Loro update bytes',
            framing: 'UTF-8 JSON LoroUpdate event',
          }
        : {
            boundary: 'Loro peer update delivery',
            encoding: 'binary',
            framing: 'native Loro update',
          },
    ),
    ...(embedded
      ? {
          liveStore: Object.freeze({
            version: '0.4.0',
            commit: 'eabb8feeff4179cd9cc626f276dd0785ef1c1b61',
          }),
        }
      : {}),
  })
  return Object.freeze({
    id: embedded ? 'loro-embedded-A' : 'loro-standalone',
    benchmarkable: true,
    benchmarkMetadata,
    metadata: benchmarkMetadata,

    bootstrap(actorId, initialDocument) {
      const state = createState(actorId, embedded)
      initializeDocument(state.doc, canonicalizeDocument(initialDocument))
      state.doc.commit()
      return state
    },

    applyLocal(state, edit) {
      const from = state.doc.oplogVersion()
      applyEdit(state.doc, edit)
      state.doc.commit()
      const nativeUpdate = state.doc.export({ mode: 'update', from })

      if (!embedded) {
        state.nativeBytes += nativeUpdate.byteLength
        return { state, update: nativeUpdate }
      }

      const encoded = encodeLiveStoreEvent({
        actorId: state.actorId,
        sequence: state.sequence++,
        nativeUpdate,
      })
      appendMaterializedEvent(state, encoded.event, encoded.bytes.byteLength, nativeUpdate.byteLength)
      return { state, update: encoded.bytes }
    },

    applyRemote(state, update) {
      if (!embedded) {
        state.doc.importBatch([update])
        return state
      }

      const { event, nativeUpdate } = decodeLiveStoreEvent(update)
      appendMaterializedEvent(state, event, update.byteLength, nativeUpdate.byteLength)
      state.doc.importBatch([nativeUpdate])
      return state
    },

    canonicalize(state) {
      return canonicalizeLoro(state.doc)
    },

    encodeSnapshot(state) {
      return state.doc.export({ mode: 'snapshot' })
    },

    decodeSnapshot(snapshot, actorId) {
      const state = createState(actorId, embedded)
      state.doc.importBatch([snapshot])
      return state
    },

    historyBytes(value) {
      const execution = value?.execution ?? value
      if (!(execution?.updates instanceof Map)) {
        throw new TypeError(`${embedded ? 'embedded' : 'standalone'} history requires the runner operation update map`)
      }
      return [...execution.updates.values()].reduce((total, update) => total + update.byteLength, 0)
    },

    embeddedEvidence(value) {
      if (!embedded) return undefined
      const execution = value?.execution ?? value
      if (execution?.updates instanceof Map) {
        const observations = [...execution.updates.values()].map((bytes) => {
          const { event, nativeUpdate } = decodeLiveStoreEvent(bytes)
          return {
            event,
            jsonBytes: bytes.byteLength,
            nativeBytes: nativeUpdate.byteLength,
            base64Bytes: Buffer.byteLength(event.args.updateBase64),
            materializerHash: hashEventMaterializer(event),
          }
        })
        const operationIds = value.trace.operations.map((operation) => operation.id)
        const nativeBytes = observations.reduce((total, item) => total + item.nativeBytes, 0)
        const base64Bytes = observations.reduce((total, item) => total + item.base64Bytes, 0)
        const jsonBytes = observations.reduce((total, item) => total + item.jsonBytes, 0)
        return {
          payloadInflation: { nativeBytes, base64Bytes, jsonBytes },
          orderingEffect: {
            _tag: 'measured',
            value: {
              mode: 'single-writer-total-order',
              serializedOperationCount: observations.length,
              evidence: {
                _tag: 'summary',
                hash: `sha256:${createHash('sha256').update(JSON.stringify(operationIds)).digest('hex')}`,
                count: operationIds.length,
                reference: 'loro-embedded-A://livestore-total-order/operation-ids',
              },
            },
          },
          logGrowth: {
            withoutCompaction: true,
            checkpoints: [{ editCount: observations.length, historyBytes: jsonBytes }],
          },
        }
      }

      const states = extractStates(execution)
      return {
        nativeBytes: states.reduce((total, state) => total + state.nativeBytes, 0),
        base64Bytes: states.reduce((total, state) => total + state.base64Bytes, 0),
        jsonBytes: states.reduce((total, state) => total + state.eventBytes, 0),
        materializerHashes: states.flatMap((state) => state.materializerHashes),
        serializedOperationCount: states.reduce((total, state) => total + state.events.length, 0),
      }
    },

    release(value) {
      for (const state of extractStates(value)) state.doc.free()
    },

    releaseExecution(execution) {
      for (const state of execution.states.values()) state.doc.free()
    },
  })
}

const createState = (actorId, embedded) => {
  const doc = new LoroDoc()
  doc.setPeerId(peerId(actorId))
  doc.configTextStyle(textStyle)
  return {
    doc,
    actorId,
    embedded,
    sequence: 0,
    nativeBytes: 0,
    base64Bytes: 0,
    eventBytes: 0,
    events: [],
    materializerHashes: [],
  }
}

const peerId = (actorId) => {
  const digest = createHash('sha256').update(actorId).digest()
  return digest.readBigUInt64BE(0).toString()
}

const initializeDocument = (doc, initial) => {
  const order = doc.getList('blockOrder')
  const blocks = doc.getMap('blocks')
  for (const block of initial.blocks) {
    order.push(block.id)
    const target = blocks.ensureMergeableMap(block.id)
    target.set('id', block.id)
    target.set('type', block.type)
    target.set('alive', true)
    const text = target.ensureMergeableText('text')
    text.insert(0, block.text)
    for (const mark of block.marks) {
      text.mark(codePointRangeToUtf16(block.text, mark), mark.key, mark.value)
    }
  }
}

const applyEdit = (doc, edit) => {
  const { block, index, order } = findBlock(doc, edit.blockId)
  const text = block.ensureMergeableText('text')

  switch (edit._tag) {
    case 'insertText':
      applyInsertText(text, edit)
      return
    case 'deleteRange': {
      const range = codePointRangeToUtf16(text.toString(), edit)
      text.delete(range.start, range.end - range.start)
      return
    }
    case 'setMark':
      text.mark(codePointRangeToUtf16(text.toString(), edit), edit.key, edit.value)
      return
    case 'unsetMark':
      text.unmark(codePointRangeToUtf16(text.toString(), edit), edit.key)
      return
    case 'setBlockType':
      block.set('type', edit.blockType)
      return
    case 'splitBlock': {
      const canonical = canonicalizeBlock(block)
      const before = Array.from(canonical.text).slice(0, edit.offset).join('')
      const after = Array.from(canonical.text).slice(edit.offset).join('')
      const splitUtf16 = before.length
      text.delete(splitUtf16, text.toString().length - splitUtf16)

      const next = doc.getMap('blocks').ensureMergeableMap(edit.newBlockId)
      next.set('id', edit.newBlockId)
      next.set('type', canonical.type)
      next.set('alive', true)
      const nextText = next.ensureMergeableText('text')
      nextText.insert(0, after)
      for (const mark of canonical.marks) {
        if (mark.end <= edit.offset) continue
        const shifted = {
          ...mark,
          start: Math.max(mark.start, edit.offset) - edit.offset,
          end: mark.end - edit.offset,
        }
        nextText.mark(codePointRangeToUtf16(after, shifted), shifted.key, shifted.value)
      }
      order.insert(index + 1, edit.newBlockId)
      return
    }
    case 'joinBlocks': {
      const nextFound = findBlock(doc, edit.nextBlockId)
      if (nextFound.index !== index + 1) {
        throw new Error(`joinBlocks requires adjacent blocks: ${edit.blockId}, ${edit.nextBlockId}`)
      }
      const next = canonicalizeBlock(nextFound.block)
      const offset = Array.from(text.toString()).length
      const utf16Offset = text.toString().length
      text.insert(utf16Offset, next.text)
      for (const mark of next.marks) {
        const shifted = { ...mark, start: mark.start + offset, end: mark.end + offset }
        text.mark(codePointRangeToUtf16(text.toString(), shifted), shifted.key, shifted.value)
      }
      nextFound.block.set('alive', false)
      order.delete(nextFound.index, 1)
      return
    }
    default:
      throw new TypeError(`Unknown logical edit tag: ${String(edit?._tag)}`)
  }
}

const findBlock = (doc, blockId) => {
  const order = doc.getList('blockOrder')
  for (let index = 0; index < order.length; index++) {
    if (order.get(index) !== blockId) continue
    const block = doc.getMap('blocks').get(blockId)
    if (block?.kind?.() === 'Map' && block.get('alive') !== false) return { block, index, order }
  }
  throw new Error(`Unknown block id: ${blockId}`)
}

const canonicalizeLoro = (doc) => {
  const order = doc.getList('blockOrder')
  const blocks = doc.getMap('blocks')
  const output = []
  for (let index = 0; index < order.length; index++) {
    const block = blocks.get(order.get(index))
    if (block?.kind?.() === 'Map' && block.get('alive') !== false) output.push(canonicalizeBlock(block))
  }
  return canonicalizeDocument({ blocks: output })
}

const canonicalizeBlock = (block) => {
  const text = block.ensureMergeableText('text')
  let offset = 0
  const marks = []
  for (const delta of text.toDelta()) {
    const length = Array.from(delta.insert).length
    for (const [key, value] of Object.entries(delta.attributes ?? {})) {
      marks.push({ start: offset, end: offset + length, key, value })
    }
    offset += length
  }
  return { id: block.get('id'), type: block.get('type'), text: text.toString(), marks }
}

const applyInsertText = (text, edit) => {
  const textBefore = text.toString()
  const insertionStart = codePointToUtf16(textBefore, edit.offset)
  const leftAttributes =
    insertionStart === 0 ? {} : attributesInRange(text, previousCodePointStart(textBefore, insertionStart), insertionStart)
  const rightAttributes =
    insertionStart === textBefore.length ? {} : attributesInRange(text, insertionStart, nextCodePointEnd(textBefore, insertionStart))
  text.insert(insertionStart, edit.text)
  const insertedRange = { start: insertionStart, end: insertionStart + edit.text.length }
  const insertedDeltas = text.sliceDelta(insertedRange.start, insertedRange.end)

  for (const key of Object.keys(textStyle)) {
    const expected = Object.is(leftAttributes[key], rightAttributes[key]) ? leftAttributes[key] : undefined
    if (insertedDeltas.every((delta) => Object.is(delta.attributes?.[key], expected))) continue
    if (expected === undefined) text.unmark(insertedRange, key)
    else text.mark(insertedRange, key, expected)
  }
}

const attributesInRange = (text, start, end) => text.sliceDelta(start, end)[0]?.attributes ?? {}

const previousCodePointStart = (text, end) =>
  end >= 2 && isHighSurrogate(text.charCodeAt(end - 2)) && isLowSurrogate(text.charCodeAt(end - 1)) ? end - 2 : end - 1

const nextCodePointEnd = (text, start) =>
  start + (isHighSurrogate(text.charCodeAt(start)) && isLowSurrogate(text.charCodeAt(start + 1)) ? 2 : 1)

const isHighSurrogate = (codeUnit) => codeUnit >= 0xd800 && codeUnit <= 0xdbff

const isLowSurrogate = (codeUnit) => codeUnit >= 0xdc00 && codeUnit <= 0xdfff

const codePointToUtf16 = (text, codePointOffset) => {
  const points = Array.from(text)
  if (!Number.isSafeInteger(codePointOffset) || codePointOffset < 0 || codePointOffset > points.length) {
    throw new RangeError(`Code-point offset ${codePointOffset} is outside [0, ${points.length}]`)
  }
  return points.slice(0, codePointOffset).join('').length
}

const codePointRangeToUtf16 = (text, { start, end }) => ({
  start: codePointToUtf16(text, start),
  end: codePointToUtf16(text, end),
})

const appendMaterializedEvent = (state, event, eventBytes, nativeBytes) => {
  const { updateBase64 } = event.args
  state.events.push(event)
  state.nativeBytes += nativeBytes
  state.base64Bytes += Buffer.byteLength(updateBase64)
  state.eventBytes += eventBytes
  state.materializerHashes.push(hashEventMaterializer(event))
}

const hashEventMaterializer = (event) => {
  const { docId, updateId, updateBase64 } = event.args
  return hashMaterializerResults([
    {
      statementSql: materializerSql,
      bindValues: [docId, updateId, updateBase64],
      writeTables: undefined,
    },
  ])
}

const extractStates = (value) => {
  if (value?.doc instanceof LoroDoc) return [value]
  if (Array.isArray(value?.states)) return value.states.filter((state) => state?.doc instanceof LoroDoc)
  if (value instanceof Map) return [...value.values()].filter((state) => state?.doc instanceof LoroDoc)
  if (Array.isArray(value)) return value.filter((state) => state?.doc instanceof LoroDoc)
  return []
}
