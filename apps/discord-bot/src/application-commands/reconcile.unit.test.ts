import { describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'

import { DiscordSnowflake } from '../threading/model.ts'
import {
  desiredApplicationCommands,
  makeApplicationCommandsReconciler,
  type ApplicationCommand,
  type ApplicationCommandsPort,
  type GuildCommandScope,
} from './index.ts'

const scope: GuildCommandScope = {
  _tag: 'GuildCommandScope',
  applicationId: Schema.decodeSync(DiscordSnowflake)('200000000000000001'),
  guildId: Schema.decodeSync(DiscordSnowflake)('300000000000000001'),
}

describe('application command reconciler', () => {
  it.effect('keeps diff read-only', () =>
    Effect.gen(function* () {
      let replaces = 0
      const reconciler = makeApplicationCommandsReconciler(
        port({
          actual: [],
          onReplace: () => replaces++,
        }),
      )
      const result = yield* reconciler.diff(scope)
      expect(result.hasChanges).toBe(true)
      expect(replaces).toBe(0)
    }),
  )

  it.effect('does not write when desired state is already satisfied', () =>
    Effect.gen(function* () {
      let replaces = 0
      const reconciler = makeApplicationCommandsReconciler(
        port({
          actual: desiredApplicationCommands,
          onReplace: () => replaces++,
        }),
      )
      const result = yield* reconciler.sync(scope)
      expect(result.changed).toBe(false)
      expect(replaces).toBe(0)
    }),
  )

  it.effect('bulk replaces once and verifies the returned state', () =>
    Effect.gen(function* () {
      let replaces = 0
      const reconciler = makeApplicationCommandsReconciler(
        port({
          actual: [],
          onReplace: () => replaces++,
        }),
      )
      const result = yield* reconciler.sync(scope)
      expect(result.changed).toBe(true)
      expect(result.before.hasChanges).toBe(true)
      expect(result.after.hasChanges).toBe(false)
      expect(replaces).toBe(1)
    }),
  )

  it.effect('refuses to replace an invalid duplicate inventory', () =>
    Effect.gen(function* () {
      let replaces = 0
      const duplicate = desiredApplicationCommands[0]
      const exit = yield* makeApplicationCommandsReconciler(
        port({
          actual: [duplicate, duplicate],
          onReplace: () => replaces++,
        }),
      )
        .sync(scope)
        .pipe(Effect.exit)
      expect(exit._tag).toBe('Failure')
      expect(replaces).toBe(0)
    }),
  )

  it.effect('fails when Discord returns residual drift after replacement', () =>
    Effect.gen(function* () {
      let replaces = 0
      const error = yield* makeApplicationCommandsReconciler(
        port({
          actual: [],
          afterReplace: [{ ...desiredApplicationCommands[0], description: 'still stale' }],
          onReplace: () => replaces++,
        }),
      )
        .sync(scope)
        .pipe(Effect.flip)
      expect(error._tag).toBe('ApplicationCommandResidualDrift')
      if (error._tag === 'ApplicationCommandResidualDrift') {
        expect(error.diff.hasChanges).toBe(true)
      }
      expect(replaces).toBe(1)
    }),
  )
})

const port = ({
  actual,
  afterReplace,
  onReplace,
}: {
  actual: ReadonlyArray<ApplicationCommand>
  afterReplace?: ReadonlyArray<ApplicationCommand>
  onReplace: () => void
}): ApplicationCommandsPort => ({
  list: () => Effect.succeed(actual),
  replace: (_scope, commands) =>
    Effect.sync(() => {
      onReplace()
      return afterReplace ?? commands
    }),
})
