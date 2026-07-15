/** The unit used by every text offset and range in the shared harness. */
export const POSITION_UNIT = 'unicode-code-point'

export const EDIT_TAGS = Object.freeze([
  'insertText',
  'deleteRange',
  'setMark',
  'unsetMark',
  'splitBlock',
  'joinBlocks',
  'setBlockType',
])

export const TEXT_ORIGINS = Object.freeze(['typing', 'paste'])
export const MARK_KEYS = Object.freeze(['bold', 'italic', 'underline', 'code', 'link'])
export const BLOCK_TYPES = Object.freeze(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem'])

/** Returns the number of Unicode code points in `text`. */
export const codePointLength = (text) => [...text].length

/** Returns the UTF-8 byte length used by the document-size workload axis. */
export const utf8ByteLength = (text) => new TextEncoder().encode(text).byteLength

/**
 * Validates the common logical-edit vocabulary shared by every benchmark arm.
 * Ranges are half-open and measured in Unicode code points, never UTF-16 code units.
 */
export const assertLogicalEdit = (edit) => {
  if (edit === null || typeof edit !== 'object' || !EDIT_TAGS.includes(edit._tag)) {
    throw new TypeError(`Unknown logical edit tag: ${String(edit?._tag)}`)
  }

  assertNonEmptyString(edit.blockId, 'blockId')

  switch (edit._tag) {
    case 'insertText':
      assertNonNegativeInteger(edit.offset, 'offset')
      assertNonEmptyString(edit.text, 'text')
      assertMember(edit.origin, TEXT_ORIGINS, 'origin')
      break
    case 'deleteRange':
      assertRange(edit.start, edit.end)
      break
    case 'setMark':
      assertRange(edit.start, edit.end)
      assertMember(edit.key, MARK_KEYS, 'key')
      if (!Object.hasOwn(edit, 'value')) throw new TypeError('setMark.value is required')
      break
    case 'unsetMark':
      assertRange(edit.start, edit.end)
      assertMember(edit.key, MARK_KEYS, 'key')
      break
    case 'splitBlock':
      assertNonNegativeInteger(edit.offset, 'offset')
      assertNonEmptyString(edit.newBlockId, 'newBlockId')
      if (edit.newBlockId === edit.blockId) throw new TypeError('newBlockId must differ from blockId')
      break
    case 'joinBlocks':
      assertNonEmptyString(edit.nextBlockId, 'nextBlockId')
      if (edit.nextBlockId === edit.blockId) throw new TypeError('nextBlockId must differ from blockId')
      break
    case 'setBlockType':
      assertMember(edit.blockType, BLOCK_TYPES, 'blockType')
      break
  }

  return edit
}

const assertRange = (start, end) => {
  assertNonNegativeInteger(start, 'start')
  assertNonNegativeInteger(end, 'end')
  if (end <= start) throw new RangeError(`Expected a non-empty half-open range, received [${start}, ${end})`)
}

const assertMember = (value, members, name) => {
  if (!members.includes(value)) throw new TypeError(`${name} must be one of: ${members.join(', ')}`)
}

const assertNonNegativeInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
}

const assertNonEmptyString = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
}
