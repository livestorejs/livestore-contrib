import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Schema } from 'effect'
import { expect, it } from 'vitest'

import { DiscordMessageRef } from '../threading/model.ts'
import { openRelayOutbox } from './outbox.ts'

const source = (messageId: string) =>
  Schema.decodeSync(DiscordMessageRef)({
    guildId: '100000000000000001',
    channelId: '100000000000000002',
    messageId,
  })

it('retains the unacknowledged reference across reopen and rejects new work at capacity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'livestore-discord-relay-'))
  const path = join(dir, 'relay.sqlite')
  try {
    const first = source('100000000000000003')
    const second = source('100000000000000004')
    const original = openRelayOutbox(path, 1)
    original.enqueue(first)
    original.close()

    const restarted = openRelayOutbox(path, 1)
    try {
      restarted.enqueue(first)
      expect(() => restarted.enqueue(second)).toThrow('Relay outbox is full')
      const entry = restarted.next()
      expect(entry).toMatchObject(first)
      if (entry === undefined) throw new Error('Expected a persisted relay entry')
      restarted.acknowledge(entry)
      restarted.enqueue(second)
      restarted.acknowledge(entry)
      expect(restarted.next()).toMatchObject(second)
    } finally {
      restarted.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
