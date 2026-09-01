import fs from 'node:fs'
import { gunzipSync } from 'node:zlib'

import { describe, expect, test } from 'vitest'

import { decodeArtifactJson } from './artifact-io.ts'
import { materializeLeaderState } from './leader-state-materialization.ts'
import { selectLeaderStateSource } from './leader-state.ts'

const decodeReference = (file: string) => {
  const data = fs.readFileSync(new URL(`../../artifacts/${file}`, import.meta.url))
  return decodeArtifactJson(gunzipSync(data).toString('utf8'))
}

const artifact = decodeReference('reference-offline-writer-recovery-browser.json.gz')

describe('Leader State source projection', () => {
  test('selects the latest Leader observation for one Client at or before the cursor', () => {
    const observations = artifact.trace.filter(
      (record) => record.clientId === 'client-a' && record.payload._tag === 'leader.sync.observed',
    )
    const earlier = observations.at(-2)!
    const later = observations.at(-1)!

    const sourceAtEarlier = selectLeaderStateSource({
      applicationId: artifact.descriptor.applicationId,
      clientId: 'client-a',
      cursorIndex: earlier.index,
      trace: artifact.trace,
    })
    const sourceBeforeLater = selectLeaderStateSource({
      applicationId: artifact.descriptor.applicationId,
      clientId: 'client-a',
      cursorIndex: later.index - 1,
      trace: artifact.trace,
    })
    const sourceAtLater = selectLeaderStateSource({
      applicationId: artifact.descriptor.applicationId,
      clientId: 'client-a',
      cursorIndex: later.index,
      trace: artifact.trace,
    })

    expect(sourceAtEarlier?.recordIndex).toBe(earlier.index)
    expect(sourceBeforeLater?.recordIndex).toBe(earlier.index)
    expect(sourceAtLater).toMatchObject({
      clientId: 'client-a',
      recordIndex: later.index,
      captureId: later.captureId,
    })
  })

  test('does not substitute session or another Client observation', () => {
    const firstClientALeader = artifact.trace.find(
      (record) => record.clientId === 'client-a' && record.payload._tag === 'leader.sync.observed',
    )!

    expect(
      selectLeaderStateSource({
        applicationId: artifact.descriptor.applicationId,
        clientId: 'client-b',
        cursorIndex: firstClientALeader.index,
        trace: artifact.trace,
      }),
    ).toBeUndefined()
  })
})

describe('Leader State materialization', () => {
  test('replays a tracked Leader observation through the registered Application materializers', async () => {
    const source = selectLeaderStateSource({
      applicationId: artifact.descriptor.applicationId,
      clientId: 'client-a',
      cursorIndex: artifact.trace.length - 1,
      trace: artifact.trace,
    })!

    const reconstructed = await materializeLeaderState(source)

    expect(reconstructed.source.recordIndex).toBe(source.recordIndex)
    expect(reconstructed.tables.map((table) => table.name)).toEqual(['todos'])
    expect(reconstructed.tables[0]?.columns).toEqual(expect.arrayContaining(['id', 'text', 'completed']))
    expect(reconstructed.tables[0]?.rows).toEqual([
      expect.objectContaining({ id: 'todo-online-b', text: 'Written while Client B is online', completed: false }),
      expect.objectContaining({ id: 'todo-offline-a', text: 'Written while Client A is offline', completed: false }),
    ])
  })

  test('surfaces materialization errors instead of returning partial State', async () => {
    const source = selectLeaderStateSource({
      applicationId: artifact.descriptor.applicationId,
      clientId: 'client-a',
      cursorIndex: artifact.trace.length - 1,
      trace: artifact.trace,
    })!
    const firstEvent = source.observation.events[0]!

    await expect(
      materializeLeaderState({
        ...source,
        observation: {
          ...source.observation,
          events: [{ ...firstEvent, name: 'v1.TodoCreated', args: { id: 'missing-required-text' } }],
        },
      }),
    ).rejects.toThrow()
  })
})
