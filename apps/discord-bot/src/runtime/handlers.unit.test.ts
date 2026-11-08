import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Redacted, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import {
  DiscordActionError,
  type DiscordActionsService,
  InteractionRoute,
  type InteractionMessage,
} from '../discord/actions.ts'
import { completeHttpDocsResponse, deliverDocsMessages } from './handlers.ts'

describe('Discord docs delivery', () => {
  it.effect('edits the deferred public response then sends ordered public follow-ups', () =>
    Effect.gen(function* () {
      const delivered: Array<{ readonly kind: string; readonly message: InteractionMessage }> = []
      const actions = recordingActions(delivered)
      yield* deliverDocsMessages(actions, route, ['first', 'second', 'third'])
      expect(
        delivered.map(({ kind, message }) => ({ kind, content: message.content, visibility: message.visibility })),
      ).toEqual([
        { kind: 'edit', content: 'first', visibility: 'public' },
        { kind: 'follow-up', content: 'second', visibility: 'public' },
        { kind: 'follow-up', content: 'third', visibility: 'public' },
      ])
    }),
  )

  it.effect('stops ordered delivery after a follow-up failure', () =>
    Effect.gen(function* () {
      const delivered: Array<{ readonly kind: string; readonly message: InteractionMessage }> = []
      let followUpOrdinal = 0
      const actions: DiscordActionsService = {
        ...recordingActions(delivered),
        followUpInteractionResponse: (message) =>
          Effect.suspend(() => {
            followUpOrdinal += 1
            if (followUpOrdinal === 2) return Effect.fail(deliveryFailure)
            delivered.push({ kind: 'follow-up', message })
            return Effect.void
          }),
      }
      yield* Effect.flip(deliverDocsMessages(actions, route, ['first', 'second', 'third', 'never-sent']))
      expect(delivered.map(({ message }) => message.content)).toEqual(['first', 'second'])
    }),
  )
})

describe('Discord HTTP docs continuation', () => {
  it.effect('edits the original response when post-acknowledgment work times out', () =>
    Effect.gen(function* () {
      const delivered: Array<{ readonly kind: string; readonly message: InteractionMessage }> = []
      const run = yield* completeHttpDocsResponse(recordingActions(delivered), route, () => Effect.never).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust('64 seconds')
      expect(delivered).toEqual([])
      yield* TestClock.adjust('1 second')
      yield* Fiber.join(run)
      expect(delivered).toEqual([
        {
          kind: 'edit',
          message: {
            route,
            visibility: 'public',
            content: 'The documentation assistant could not complete this request. Please try again.',
          },
        },
      ])
    }),
  )

  it.effect('keeps a delivered original answer if a follow-up fails', () =>
    Effect.gen(function* () {
      const delivered: Array<{ readonly kind: string; readonly message: InteractionMessage }> = []
      const actions = {
        ...recordingActions(delivered),
        followUpInteractionResponse: () => Effect.fail(deliveryFailure),
      }
      yield* completeHttpDocsResponse(actions, route, (tracked) =>
        deliverDocsMessages(tracked, route, ['first', 'next']),
      )
      expect(delivered.map(({ message }) => message.content)).toEqual(['first'])
    }),
  )
})

const route = Schema.decodeSync(InteractionRoute)({
  interactionId: '100000000000000001',
  applicationId: '100000000000000002',
  token: Redacted.make('interaction-token'),
})

const deliveryFailure = new DiscordActionError({
  operation: 'follow-up-interaction-response',
  message: 'injected follow-up failure',
  cause: new Error('injected'),
})

const recordingActions = (
  delivered: Array<{ readonly kind: string; readonly message: InteractionMessage }>,
): DiscordActionsService => ({
  deferInteraction: () => Effect.die('unused'),
  editInteractionResponse: (message) =>
    Effect.sync(() => {
      delivered.push({ kind: 'edit', message })
    }),
  followUpInteractionResponse: (message) =>
    Effect.sync(() => {
      delivered.push({ kind: 'follow-up', message })
    }),
  respondInteraction: () => Effect.die('unused'),
})
