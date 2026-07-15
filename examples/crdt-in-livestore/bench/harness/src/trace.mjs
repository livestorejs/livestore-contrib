import { MARK_KEYS, POSITION_UNIT, assertLogicalEdit, utf8ByteLength } from './model.mjs'
import { applyLogicalEdit, canonicalizeDocument, documentsEqual } from './oracle.mjs'

export const DOCUMENT_SIZES_BYTES = Object.freeze([2 * 1024, 20 * 1024, 200 * 1024])
export const EDIT_COUNTS = Object.freeze([1_000, 10_000, 100_000])
export const CONCURRENCY_LEVELS = Object.freeze([2, 3, 8])
export const OFFLINE_DURATION_RATIOS = Object.freeze([0.01, 0.05, 0.2])

/** The required 3 x 3 x 3 benchmark matrix. */
export const WORKLOAD_MATRIX = Object.freeze(
  DOCUMENT_SIZES_BYTES.flatMap((docSizeBytes) =>
    EDIT_COUNTS.flatMap((editCount) =>
      CONCURRENCY_LEVELS.map((concurrency) =>
        Object.freeze({
          id: `${docSizeBytes / 1024}kb-${editCount}edits-${concurrency}way`,
          docSizeBytes,
          editCount,
          concurrency,
          offlineBranchDurations: Object.freeze(defaultOfflineDurations(editCount)),
        }),
      ),
    ),
  ),
)

/**
 * Compiles actor turns and delivery opportunities without inspecting document state.
 * An offline actor is omitted as both sender and recipient until its logical window ends.
 */
export const compileSchedule = ({ seed, actorIds, editCount, offlineWindows }) => {
  assertPositiveInteger(editCount, 'editCount')
  if (!Array.isArray(actorIds) || actorIds.length < 2 || new Set(actorIds).size !== actorIds.length) {
    throw new TypeError('actorIds must contain at least two unique actor ids')
  }
  if (!Array.isArray(offlineWindows)) throw new TypeError('offlineWindows must be an array')

  const random = createSeededRandom(`${normalizeSeed(seed)}:schedule`)
  const actorOffset = random.integer(actorIds.length)
  const ticks = Array.from({ length: editCount }, (_, logicalTick) => {
    const actorId = actorIds[(logicalTick + actorOffset) % actorIds.length]
    const offlineActorIds = actorIds.filter((candidate) => isOffline(candidate, logicalTick, offlineWindows))
    const onlineActorIds = actorIds.filter((candidate) => !offlineActorIds.includes(candidate))
    const reconnectedActorIds = actorIds.filter((candidate) =>
      offlineWindows.some((window) => window.actorId === candidate && window.endLogicalTick === logicalTick),
    )
    const beforeSyncPairs = reconnectedActorIds.length === 0 ? [] : orderedPairs(onlineActorIds)
    const afterSyncPairs = offlineActorIds.includes(actorId)
      ? []
      : onlineActorIds.filter((targetActorId) => targetActorId !== actorId).map((targetActorId) => ({
          fromActorId: actorId,
          toActorId: targetActorId,
        }))
    return Object.freeze({
      logicalTick,
      actorId,
      offlineActorIds: Object.freeze(offlineActorIds),
      beforeSyncPairs: Object.freeze(beforeSyncPairs.map(Object.freeze)),
      afterSyncPairs: Object.freeze(afterSyncPairs.map(Object.freeze)),
    })
  })

  return Object.freeze({
    ticks: Object.freeze(ticks),
    finalDrainPairs: Object.freeze(orderedPairs(actorIds).map(Object.freeze)),
  })
}

/**
 * Generates deterministic, executable edit and sync events.
 *
 * Each actor owns one block lane, so edits generated from divergent actor views
 * remain valid when source-ordered remote lanes are delivered later.
 */
export const generateTrace = ({
  seed,
  docSizeBytes,
  editCount,
  concurrency,
  offlineBranchDurations = defaultOfflineDurations(editCount),
}) => {
  assertPositiveInteger(docSizeBytes, 'docSizeBytes')
  assertPositiveInteger(editCount, 'editCount')
  assertPositiveInteger(concurrency, 'concurrency')
  if (concurrency < 2) throw new RangeError('concurrency must be at least 2')
  if (!Array.isArray(offlineBranchDurations) || offlineBranchDurations.length === 0) {
    throw new TypeError('offlineBranchDurations must be a non-empty array')
  }
  offlineBranchDurations.forEach((duration) => assertPositiveInteger(duration, 'offlineBranchDuration'))

  const normalizedSeed = normalizeSeed(seed)
  const actorIds = Array.from({ length: concurrency }, (_, index) => `actor-${index + 1}`)
  const initialDocument = createInitialDocument(docSizeBytes, actorIds)
  const offlineWindows = createOfflineWindows({
    actorIds,
    editCount,
    offlineBranchDurations,
    random: createSeededRandom(`${normalizedSeed}:offline`),
  })
  const schedule = compileSchedule({ seed: normalizedSeed, actorIds, editCount, offlineWindows })
  const categorySchedule = createCategorySchedule(editCount, createSeededRandom(`${normalizedSeed}:categories`))
  const contentRandom = createSeededRandom(`${normalizedSeed}:content`)
  const actorDocuments = new Map(actorIds.map((actorId) => [actorId, canonicalizeDocument(initialDocument)]))
  const operationsByActor = new Map(actorIds.map((actorId) => [actorId, []]))
  const deliveredFrontiers = new Map(
    actorIds.map((targetActorId) => [targetActorId, new Map(actorIds.map((sourceActorId) => [sourceActorId, 0]))]),
  )
  const markToggle = new Map()
  const events = []
  const operations = []

  const deliver = ({ fromActorId, toActorId }, logicalTick, reason, emitEmpty = false) => {
    const sourceOperations = operationsByActor.get(fromActorId)
    const start = deliveredFrontiers.get(toActorId).get(fromActorId)
    const pending = sourceOperations.slice(start)
    if (pending.length === 0 && !emitEmpty) return
    let targetDocument = actorDocuments.get(toActorId)
    for (const operation of pending) targetDocument = applyLogicalEdit(targetDocument, operation.edit)
    actorDocuments.set(toActorId, targetDocument)
    deliveredFrontiers.get(toActorId).set(fromActorId, sourceOperations.length)
    events.push({
      _tag: 'sync',
      logicalTick,
      fromActorId,
      toActorId,
      operationIds: pending.map((operation) => operation.id),
      reason,
    })
  }

  for (const tick of schedule.ticks) {
    for (const pair of tick.beforeSyncPairs) deliver(pair, tick.logicalTick, 'reconnect')

    const actorOperations = operationsByActor.get(tick.actorId)
    const actorSeq = actorOperations.length + 1
    const edit = createEdit({
      category: categorySchedule[tick.logicalTick],
      document: actorDocuments.get(tick.actorId),
      blockId: initialDocument.actorLanes[tick.actorId],
      random: contentRandom,
      markToggle,
    })
    assertLogicalEdit(edit)
    actorDocuments.set(tick.actorId, applyLogicalEdit(actorDocuments.get(tick.actorId), edit))
    const offlineWindow = offlineWindows.find(
      (window) =>
        window.actorId === tick.actorId &&
        tick.logicalTick >= window.startLogicalTick &&
        tick.logicalTick < window.endLogicalTick,
    )
    const operation = {
      id: `${tick.actorId}:${actorSeq}`,
      actorId: tick.actorId,
      actorSeq,
      logicalTick: tick.logicalTick,
      offlineWindowId: offlineWindow?.id ?? null,
      edit,
    }
    actorOperations.push(operation)
    deliveredFrontiers.get(tick.actorId).set(tick.actorId, actorSeq)
    operations.push(operation)
    events.push({ _tag: 'edit', logicalTick: tick.logicalTick, operation })

    for (const pair of tick.afterSyncPairs) deliver(pair, tick.logicalTick, 'online')
  }

  for (const pair of schedule.finalDrainPairs) deliver(pair, editCount, 'final-drain', true)

  const finalDocuments = actorIds.map((actorId) => actorDocuments.get(actorId))
  if (!finalDocuments.every((document) => documentsEqual(document, finalDocuments[0]))) {
    throw new Error('Final all-to-all drain did not converge the oracle shadows')
  }

  return {
    schemaVersion: 2,
    seed: normalizedSeed,
    positionUnit: POSITION_UNIT,
    workload: { docSizeBytes, editCount, concurrency, offlineBranchDurations: [...offlineBranchDurations] },
    initialDocument,
    actorIds,
    offlineWindows,
    events,
    operations,
    finalDeliveredFrontiers: Object.fromEntries(
      actorIds.map((targetActorId) => [targetActorId, Object.fromEntries(deliveredFrontiers.get(targetActorId))]),
    ),
    finalOracleDocument: finalDocuments[0],
  }
}

/** Returns observable trace composition without asserting benchmark quality. */
export const summarizeTrace = (trace) => {
  const counts = { typing: 0, delete: 0, markToggle: 0, paste: 0 }
  for (const { edit } of trace.operations) {
    if (edit._tag === 'insertText') counts[edit.origin] += 1
    else if (edit._tag === 'deleteRange') counts.delete += 1
    else if (edit._tag === 'setMark' || edit._tag === 'unsetMark') counts.markToggle += 1
  }
  return {
    operationCount: trace.operations.length,
    counts,
    proportions: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, count / trace.operations.length])),
  }
}

const createInitialDocument = (targetBytes, actorIds) => {
  const corpus = 'Local first editing keeps intent close to the document. '
  const separatorBytes = 1
  const blockCount = Math.max(actorIds.length, Math.ceil(targetBytes / 1024))
  const textBytes = targetBytes - (blockCount - 1) * separatorBytes
  if (textBytes < blockCount) throw new RangeError('docSizeBytes is too small for one actor-owned block per actor')
  const baseLength = Math.floor(textBytes / blockCount)
  let remainder = textBytes % blockCount
  const blocks = Array.from({ length: blockCount }, (_, index) => {
    const length = baseLength + (remainder-- > 0 ? 1 : 0)
    return { id: `block-${index + 1}`, type: 'paragraph', text: repeatAsciiToLength(corpus, length), marks: [] }
  })
  const canonicalText = blocks.map((block) => block.text).join('\n')
  if (utf8ByteLength(canonicalText) !== targetBytes) throw new Error('Initial document byte-size invariant failed')
  return {
    blocks,
    canonicalText,
    actorLanes: Object.fromEntries(actorIds.map((actorId, index) => [actorId, blocks[index].id])),
  }
}

const createCategorySchedule = (editCount, random) => {
  const counts = {
    typing: Math.round(editCount * 0.7),
    delete: Math.round(editCount * 0.15),
    markToggle: Math.round(editCount * 0.1),
  }
  counts.paste = editCount - counts.typing - counts.delete - counts.markToggle
  const schedule = []
  while (schedule.length < editCount) {
    const remainingTotal = Object.values(counts).reduce((sum, count) => sum + count, 0)
    let pick = random.integer(remainingTotal)
    let category
    for (const candidate of ['typing', 'delete', 'markToggle', 'paste']) {
      if (pick < counts[candidate]) {
        category = candidate
        break
      }
      pick -= counts[candidate]
    }
    const runLength = category === 'typing' ? Math.min(counts.typing, 2 + random.integer(7)) : 1
    for (let index = 0; index < runLength; index++) schedule.push(category)
    counts[category] -= runLength
  }
  return schedule
}

const createOfflineWindows = ({ actorIds, editCount, offlineBranchDurations, random }) =>
  actorIds.slice(1).map((actorId, index) => {
    const requestedDuration = offlineBranchDurations[index % offlineBranchDurations.length]
    const duration = Math.min(requestedDuration, Math.max(1, editCount - 1))
    const latestStart = Math.max(0, editCount - duration)
    const startLogicalTick = random.integer(latestStart + 1)
    return {
      id: `offline-${index + 1}`,
      actorId,
      startLogicalTick,
      endLogicalTick: startLogicalTick + duration,
      durationLogicalEdits: duration,
    }
  })

const createEdit = ({ category, document, blockId, random, markToggle }) => {
  const block = document.blocks.find((candidate) => candidate.id === blockId)
  const length = Array.from(block.text).length
  if (category === 'typing') {
    const tokens = ['a', 'e', ' the', ' local', ' sync', 'é', '🙂']
    return {
      _tag: 'insertText',
      blockId,
      offset: random.integer(length + 1),
      text: tokens[random.integer(tokens.length)],
      origin: 'typing',
    }
  }
  if (category === 'paste') {
    const pastes = ['pasted paragraph', 'shared editing context', 'line one\nline two', 'naïve café 🙂']
    return {
      _tag: 'insertText',
      blockId,
      offset: random.integer(length + 1),
      text: pastes[random.integer(pastes.length)],
      origin: 'paste',
    }
  }

  const start = random.integer(Math.max(1, length))
  const end = Math.min(length, start + 1 + random.integer(Math.min(12, Math.max(1, length - start))))
  if (category === 'delete') return { _tag: 'deleteRange', blockId, start, end }

  const key = MARK_KEYS[random.integer(MARK_KEYS.length)]
  const toggleKey = `${blockId}:${key}`
  const isSet = markToggle.get(toggleKey) === true
  markToggle.set(toggleKey, !isSet)
  return isSet
    ? { _tag: 'unsetMark', blockId, start, end, key }
    : { _tag: 'setMark', blockId, start, end, key, value: key === 'link' ? 'https://example.test' : true }
}

/** SplitMix64: deterministic and independent of engine-provided randomness. */
const createSeededRandom = (seed) => {
  let state = BigInt.asUintN(64, hashSeed(normalizeSeed(seed)))
  const next = () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n)
    let value = state
    value = BigInt.asUintN(64, (value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n)
    value = BigInt.asUintN(64, (value ^ (value >> 27n)) * 0x94d049bb133111ebn)
    return BigInt.asUintN(64, value ^ (value >> 31n))
  }
  return {
    integer: (exclusiveMaximum) => {
      if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum <= 0) {
        throw new RangeError('exclusiveMaximum must be a positive safe integer')
      }
      return Number(next() % BigInt(exclusiveMaximum))
    },
  }
}

const hashSeed = (seed) => {
  let hash = 0xcbf29ce484222325n
  for (const codePoint of seed) {
    for (const byte of new TextEncoder().encode(codePoint)) {
      hash ^= BigInt(byte)
      hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    }
  }
  return hash
}

const normalizeSeed = (seed) => {
  if (typeof seed !== 'string' && typeof seed !== 'number' && typeof seed !== 'bigint') {
    throw new TypeError('seed must be a string, number, or bigint')
  }
  return String(seed)
}

function defaultOfflineDurations(editCount) {
  return OFFLINE_DURATION_RATIOS.map((ratio) => Math.max(1, Math.round(editCount * ratio)))
}

const orderedPairs = (actorIds) =>
  actorIds.flatMap((fromActorId) =>
    actorIds
      .filter((toActorId) => toActorId !== fromActorId)
      .map((toActorId) => ({ fromActorId, toActorId })),
  )

const isOffline = (actorId, logicalTick, offlineWindows) =>
  offlineWindows.some(
    (window) =>
      window.actorId === actorId && logicalTick >= window.startLogicalTick && logicalTick < window.endLogicalTick,
  )

const repeatAsciiToLength = (source, length) => source.repeat(Math.ceil(length / source.length)).slice(0, length)

const assertPositiveInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
}
