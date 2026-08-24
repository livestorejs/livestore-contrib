import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import { ThreadCandidate } from './model.ts'
import {
  deriveLocalThreadName,
  projectAiTitleInput,
  resolveThreadName,
  TitleProposalError,
  validateThreadName,
} from './title.ts'

const candidate = Schema.decodeUnknownSync(ThreadCandidate)({
  environment: 'staging',
  source: {
    guildId: '10000000000000001',
    channelId: '10000000000000002',
    messageId: '10000000000000003',
  },
  sourceChannelKind: 'GuildText',
  messageKind: 'Default',
  hasMessageReference: false,
  authorKind: 'Human',
  content: 'How do I sync across tabs?',
  attachmentCount: 0,
  hasPoll: false,
  stickerCount: 0,
  trigger: { _tag: 'Automatic', deliveryCorrelation: 'session:1' },
})
describe('thread titles', () => {
  it('projects only bounded redacted public text', () => {
    const projected = projectAiTitleInput(
      `Ask <@12345678901234567> in <#12345678901234568> with <@&12345678901234569> <:ship:12345678901234570> https://example.test/${'x'.repeat(600)}`,
    )
    expect(projected).toContain('[user]')
    expect(projected).toContain('[channel]')
    expect(projected).toContain('[role]')
    expect(projected).toContain('[emoji]')
    expect(projected).toContain('[link]')
    expect(projected).not.toContain('12345678901234567')
    expect(projected === undefined ? 0 : [...projected].length).toBeLessThanOrEqual(500)
  })

  it('does not send placeholder-only text to a provider', () => {
    expect(projectAiTitleInput('<@12345678901234567> https://example.test <:ok:12345678901234568>')).toBeUndefined()
  })

  it('validates external proposals and deterministically bounds local names', () => {
    expect(validateThreadName('  A useful title  ')).toBe('A useful title')
    expect(validateThreadName(' ')).toBeUndefined()
    expect(validateThreadName('x'.repeat(101))).toBeUndefined()
    expect(deriveLocalThreadName(' ')).toBe('Discussion')
    expect([...deriveLocalThreadName('🚀'.repeat(101))]).toHaveLength(100)
  })

  it.effect('uses a valid proposal only for an explicitly disclosed channel', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const title = yield* resolveThreadName(
        candidate,
        { aiTitleChannelIds: new Set([candidate.source.channelId]) },
        {
          propose: (input) =>
            Effect.sync(() => {
              seen.push(input)
              return 'Cross-tab sync'
            }),
        },
      )
      expect(title).toBe('Cross-tab sync')
      expect(seen).toEqual([candidate.content])
    }),
  )

  it.effect('falls back locally on provider or validation failure', () =>
    Effect.gen(function* () {
      const providerFailure = yield* resolveThreadName(
        candidate,
        { aiTitleChannelIds: new Set([candidate.source.channelId]) },
        {
          propose: () => new TitleProposalError({ code: 'quota', message: 'quota exceeded' }),
        },
      )
      const invalidProposal = yield* resolveThreadName(
        candidate,
        { aiTitleChannelIds: new Set([candidate.source.channelId]) },
        {
          propose: () => Effect.succeed(''),
        },
      )
      expect(providerFailure).toBe(candidate.content)
      expect(invalidProposal).toBe(candidate.content)
    }),
  )
})
