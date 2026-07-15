import { assertLogicalEdit } from './model.mjs'

/** Returns the semantic representation used for cross-arm correctness checks. */
export const canonicalizeDocument = (document) => ({
  blocks: document.blocks.map((block) => {
    const textLength = toCodePoints(block.text).length
    const marks = block.marks
      .filter((mark) => mark.start < mark.end)
      .map((mark) => {
        assertRange(mark.start, mark.end, textLength, `mark ${mark.key}`)
        return { ...mark }
      })
      .sort(compareMarks)

    return {
      id: block.id,
      type: block.type,
      text: block.text,
      marks: coalesceMarks(marks),
    }
  }),
})

/** Applies one logical rich-text edit to an immutable semantic document. */
export const applyLogicalEdit = (document, edit) => {
  assertLogicalEdit(edit)
  const canonical = canonicalizeDocument(document)

  switch (edit._tag) {
    case 'insertText':
      return applyInsert(canonical, edit)
    case 'deleteRange':
      return applyDelete(canonical, edit)
    case 'setMark':
      return applySetMark(canonical, edit)
    case 'unsetMark':
      return applyUnsetMark(canonical, edit)
    case 'splitBlock':
      return applySplit(canonical, edit)
    case 'joinBlocks':
      return applyJoin(canonical, edit)
    case 'setBlockType':
      return updateBlock(canonical, edit.blockId, (block) => ({ ...block, type: edit.blockType }))
  }
}

/** Canonical semantic equality deliberately ignores implementation snapshots. */
export const documentsEqual = (left, right) =>
  JSON.stringify(canonicalizeDocument(left)) === JSON.stringify(canonicalizeDocument(right))

const applyInsert = (document, edit) =>
  updateBlock(document, edit.blockId, (block) => {
    const text = toCodePoints(block.text)
    assertOffset(edit.offset, text.length, 'insert offset')
    const inserted = toCodePoints(edit.text)
    const amount = inserted.length

    return {
      ...block,
      text: [...text.slice(0, edit.offset), ...inserted, ...text.slice(edit.offset)].join(''),
      marks: block.marks.map((mark) => {
        // Insertion at either mark boundary does not inherit the mark. Interior insertion does.
        if (edit.offset <= mark.start) return { ...mark, start: mark.start + amount, end: mark.end + amount }
        if (edit.offset < mark.end) return { ...mark, end: mark.end + amount }
        return mark
      }),
    }
  })

const applyDelete = (document, edit) =>
  updateBlock(document, edit.blockId, (block) => {
    const text = toCodePoints(block.text)
    assertRange(edit.start, edit.end, text.length, 'delete range')
    const mapPosition = (position) => {
      if (position <= edit.start) return position
      if (position >= edit.end) return position - (edit.end - edit.start)
      return edit.start
    }

    return {
      ...block,
      text: [...text.slice(0, edit.start), ...text.slice(edit.end)].join(''),
      marks: block.marks.map((mark) => ({
        ...mark,
        start: mapPosition(mark.start),
        end: mapPosition(mark.end),
      })),
    }
  })

const applySetMark = (document, edit) =>
  updateBlock(document, edit.blockId, (block) => {
    assertRange(edit.start, edit.end, toCodePoints(block.text).length, 'mark range')
    const marks = replaceMarkRange(block.marks, edit.start, edit.end, edit.key)
    marks.push({ start: edit.start, end: edit.end, key: edit.key, value: edit.value })
    return { ...block, marks }
  })

const applyUnsetMark = (document, edit) =>
  updateBlock(document, edit.blockId, (block) => {
    assertRange(edit.start, edit.end, toCodePoints(block.text).length, 'unmark range')
    return { ...block, marks: replaceMarkRange(block.marks, edit.start, edit.end, edit.key) }
  })

const applySplit = (document, edit) => {
  if (document.blocks.some((block) => block.id === edit.newBlockId)) {
    throw new Error(`Duplicate block id: ${edit.newBlockId}`)
  }
  const index = findBlockIndex(document, edit.blockId)
  const block = document.blocks[index]
  const text = toCodePoints(block.text)
  assertOffset(edit.offset, text.length, 'split offset')

  const leftMarks = []
  const rightMarks = []
  for (const mark of block.marks) {
    if (mark.start < edit.offset) leftMarks.push({ ...mark, end: Math.min(mark.end, edit.offset) })
    if (mark.end > edit.offset) {
      rightMarks.push({
        ...mark,
        start: Math.max(mark.start, edit.offset) - edit.offset,
        end: mark.end - edit.offset,
      })
    }
  }

  const replacement = [
    { ...block, text: text.slice(0, edit.offset).join(''), marks: leftMarks },
    { id: edit.newBlockId, type: block.type, text: text.slice(edit.offset).join(''), marks: rightMarks },
  ]
  return canonicalizeDocument({ blocks: document.blocks.toSpliced(index, 1, ...replacement) })
}

const applyJoin = (document, edit) => {
  const index = findBlockIndex(document, edit.blockId)
  const next = document.blocks[index + 1]
  if (next?.id !== edit.nextBlockId) {
    throw new Error(`joinBlocks requires adjacent blocks: ${edit.blockId}, ${edit.nextBlockId}`)
  }
  const block = document.blocks[index]
  const offset = toCodePoints(block.text).length
  const joined = {
    ...block,
    text: block.text + next.text,
    marks: [...block.marks, ...next.marks.map((mark) => ({ ...mark, start: mark.start + offset, end: mark.end + offset }))],
  }
  return canonicalizeDocument({ blocks: document.blocks.toSpliced(index, 2, joined) })
}

const replaceMarkRange = (marks, start, end, key) =>
  marks.flatMap((mark) => {
    if (mark.key !== key || mark.end <= start || mark.start >= end) return [mark]
    const pieces = []
    if (mark.start < start) pieces.push({ ...mark, end: start })
    if (mark.end > end) pieces.push({ ...mark, start: end })
    return pieces
  })

const coalesceMarks = (marks) => {
  const result = []
  for (const mark of marks) {
    const previous = result.at(-1)
    if (
      previous !== undefined &&
      previous.key === mark.key &&
      valuesEqual(previous.value, mark.value) &&
      mark.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, mark.end)
    } else {
      result.push({ ...mark })
    }
  }
  return result
}

const updateBlock = (document, id, update) => {
  const index = findBlockIndex(document, id)
  return canonicalizeDocument({ blocks: document.blocks.with(index, update(document.blocks[index])) })
}

const findBlockIndex = (document, id) => {
  const index = document.blocks.findIndex((block) => block.id === id)
  if (index === -1) throw new Error(`Unknown block id: ${id}`)
  return index
}

const assertOffset = (offset, length, label) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new RangeError(`${label} ${offset} is outside [0, ${length}]`)
  }
}

const assertRange = (start, end, length, label) => {
  assertOffset(start, length, `${label} start`)
  assertOffset(end, length, `${label} end`)
  if (start >= end) throw new RangeError(`${label} must be non-empty and half-open`)
}

const toCodePoints = (text) => Array.from(text)
const valuesEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const compareMarks = (left, right) =>
  left.key.localeCompare(right.key) ||
  JSON.stringify(left.value).localeCompare(JSON.stringify(right.value)) ||
  left.start - right.start ||
  left.end - right.end
