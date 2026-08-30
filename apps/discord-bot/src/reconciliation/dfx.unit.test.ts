import { describe, expect, it } from 'vitest'

import { decodeDiscordSnowflake } from '../journal/model.ts'
import { classifyThreadChannel } from './dfx.ts'

const sourceMessageId = decodeDiscordSnowflake('100000000000000901')
const channelId = decodeDiscordSnowflake('100000000000000900')

describe('DFX thread observation classification', () => {
  it('accepts only a Discord thread whose ID and parent anchor the source', () => {
    expect(
      classifyThreadChannel({ sourceMessageId, channelId }, { id: sourceMessageId, parent_id: channelId, type: 11 }),
    ).toEqual({ _tag: 'ExactSourceThread', threadId: sourceMessageId })
  })

  it.each([
    { id: '100000000000000999', parent_id: channelId, type: 11 },
    { id: sourceMessageId, parent_id: '100000000000000999', type: 11 },
    { id: sourceMessageId, parent_id: channelId, type: 0 },
    { id: sourceMessageId },
  ])('fails closed rather than guessing from an unanchored channel', (channel) => {
    expect(classifyThreadChannel({ sourceMessageId, channelId }, channel)).toEqual({
      _tag: 'Unrun',
      reason: 'source_anchor_not_proven',
    })
  })
})
