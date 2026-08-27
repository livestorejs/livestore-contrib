import { describe, expect, it } from 'vitest'

import { makeFakeWorld } from './fake-transport.ts'
import { parseLiveManifest } from './live-manifest.ts'
import { runLiveStaging } from './live-runner.ts'
import {
  liveWriteConfirmation,
  scenarioIdsForSelection,
  topicSentinel,
  type ScenarioId,
  type ScenarioRung,
  type Snowflake,
} from './model.ts'

const manifest = parseLiveManifest({
  schemaVersion: 1,
  environment: 'staging',
  actorBotTokenRef: 'op://LiveStore/Discord staging actor/token',
  botControlSocket: '/run/discord-bot/staging/control.sock',
  target: {
    guildId: '111111111111111111',
    channelId: '222222222222222222',
    docsChannelIds: { public: '222222222222222222', restricted: '333333333333333333' },
    allowedChannelIds: ['222222222222222222', '333333333333333333'],
    requiredTopicSentinel: topicSentinel,
    pollIntervalMs: 1,
    timeoutMs: 4,
  },
})

const scenariosByRung: ReadonlyArray<readonly [ScenarioRung, ReadonlyArray<ScenarioId>]> = [
  ['tracer', ['automated-author-rejected', 'operator-retroactive']],
  [
    'unattended',
    ['automated-author-rejected', 'operator-retroactive', 'operator-idempotent', 'operator-concurrent'],
  ],
  [
    'attended',
    [
      'automatic-eligible',
      'automatic-filtered',
      'message-action-authorized',
      'message-action-denied',
      'docs-public',
      'docs-role-restricted',
      'docs-denied',
    ],
  ],
  [
    'full',
    [
      'automatic-eligible',
      'automatic-filtered',
      'automated-author-rejected',
      'operator-retroactive',
      'operator-idempotent',
      'operator-concurrent',
      'message-action-authorized',
      'message-action-denied',
      'docs-public',
      'docs-role-restricted',
      'docs-denied',
    ],
  ],
]

describe('live staging write gate', () => {
  it.each(scenariosByRung)('defines the %s rollout rung explicitly', (rung, expected) => {
    expect(scenarioIdsForSelection({ _tag: 'Rung', rung })).toEqual(expected)
  })

  it('runs only explicit scenarios after one target preflight and receipts every lane', async () => {
    const world = makeFakeWorld(manifest.target)
    const inspected: Snowflake[] = []
    const receipt = await runLiveStaging({
      manifest,
      confirmation: liveWriteConfirmation,
      transport: {
        ...world.transport,
        inspectChannel: async (channelId) => {
          inspected.push(channelId)
          return world.transport.inspectChannel(channelId)
        },
      },
      selection: { _tag: 'Scenarios', scenarios: ['operator-retroactive'] },
      humanAssisted: false,
    })

    expect(inspected).toEqual([manifest.target.channelId, manifest.target.docsChannelIds.restricted])
    expect(receipt.verdict).toBe('PASS')
    expect(receipt.scenarios).toHaveLength(11)
    expect(receipt.scenarios.filter((scenario) => scenario.verdict === 'PASS').map((scenario) => scenario.scenario)).toEqual([
      'operator-retroactive',
    ])
    expect(
      receipt.scenarios
        .filter((scenario) => scenario.scenario !== 'operator-retroactive')
        .every((scenario) => scenario.verdict === 'UNRUN' && scenario.reason === 'not-selected'),
    ).toBe(true)
  })

  it('distinguishes selected missing prerequisites from unselected lanes', async () => {
    const receipt = await runLiveStaging({
      manifest: undefined,
      confirmation: liveWriteConfirmation,
      transport: undefined,
      selection: { _tag: 'Rung', rung: 'tracer' },
      humanAssisted: false,
    })

    expect(
      receipt.scenarios
        .filter((scenario) =>
          scenario.scenario === 'automated-author-rejected' || scenario.scenario === 'operator-retroactive',
        )
        .every((scenario) => scenario.reason === 'prerequisite-missing'),
    ).toBe(true)
    expect(receipt.verdict).toBe('UNRUN')
    expect(receipt.scenarios.filter((scenario) => scenario.reason === 'not-selected')).toHaveLength(9)
  })

  it('stops selected lanes on transport failure without relabeling unselected lanes', async () => {
    const world = makeFakeWorld(manifest.target)
    const receipt = await runLiveStaging({
      manifest,
      confirmation: liveWriteConfirmation,
      transport: {
        ...world.transport,
        createMessage: async () => {
          throw new Error('transport unavailable')
        },
      },
      selection: { _tag: 'Rung', rung: 'unattended' },
      humanAssisted: false,
    })

    expect(receipt.verdict).toBe('FAIL')
    expect(receipt.scenarios.find((scenario) => scenario.scenario === 'automated-author-rejected')).toMatchObject({
      verdict: 'FAIL',
      reason: 'transport-failed',
    })
    expect(receipt.scenarios.filter((scenario) => scenario.reason === 'prerequisite-missing')).toHaveLength(3)
    expect(receipt.scenarios.filter((scenario) => scenario.reason === 'not-selected')).toHaveLength(7)
  })
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
