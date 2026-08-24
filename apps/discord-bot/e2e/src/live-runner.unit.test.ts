import { describe, expect, it } from 'vitest'

import { makeFakeWorld } from './fake-transport.ts'
import { parseLiveManifest } from './live-manifest.ts'
import { runLiveStaging } from './live-runner.ts'
import { liveWriteConfirmation, topicSentinel } from './model.ts'

const manifest = parseLiveManifest({
  schemaVersion: 1,
  environment: 'staging',
  actorBotTokenRef: 'op://LiveStore/Discord staging actor/token',
  botControlSocket: '/run/discord-bot/staging/control.sock',
  target: {
    guildId: '111111111111111111',
    channelId: '222222222222222222',
    allowedChannelIds: ['222222222222222222'],
    requiredTopicSentinel: topicSentinel,
    pollIntervalMs: 1,
    timeoutMs: 4,
  },
})

describe('live staging write gate', () => {
  it.each([
    ['manifest', { manifest: undefined, confirmation: liveWriteConfirmation }],
    ['confirmation', { manifest, confirmation: undefined }],
    ['exact confirmation', { manifest, confirmation: 'yes' }],
    ['transport', { manifest, confirmation: liveWriteConfirmation }],
  ])('reports every lane UNRUN when %s is absent', async (_label, partial) => {
    const receipt = await runLiveStaging({
      manifest: partial.manifest,
      confirmation: partial.confirmation,
      transport: undefined,
      humanAssisted: false,
    })

    expect(receipt.verdict).toBe('UNRUN')
    expect(receipt.scenarios.every((scenario) => scenario.verdict === 'UNRUN')).toBe(true)
    expect(receipt.scenarios.every((scenario) => scenario.reason === 'prerequisite-missing')).toBe(true)
  })

  it('runs automated lanes but preserves human lanes as UNRUN', async () => {
    const world = makeFakeWorld(manifest.target)
    const receipt = await runLiveStaging({
      manifest,
      confirmation: liveWriteConfirmation,
      transport: world.transport,
      humanAssisted: false,
    })

    expect(receipt.verdict).toBe('UNRUN')
    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'PASS')).toHaveLength(4)
    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'UNRUN')).toHaveLength(7)
  })
})
