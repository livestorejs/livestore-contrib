import * as Effect from 'effect/Effect'

import { desiredApplicationCommands } from './desired.ts'
import { diffApplicationCommands } from './diff.ts'
import {
  ApplicationCommandInventoryInvalid,
  ApplicationCommandResidualDrift,
  type ApplicationCommand,
  type ApplicationCommandScope,
} from './model.ts'
import type { ApplicationCommandsPort } from './port.ts'

export const makeApplicationCommandsReconciler = (port: ApplicationCommandsPort) => ({
  diff: (scope: ApplicationCommandScope) =>
    port.list(scope).pipe(
      Effect.map((actual) => diffApplicationCommands(desiredForScope(scope), actual)),
      Effect.withSpan('discord.applicationCommands.diff'),
    ),
  sync: Effect.fn('discord.applicationCommands.sync')(function* (scope: ApplicationCommandScope) {
    const desired = desiredForScope(scope)
    const actual = yield* port.list(scope)
    const before = diffApplicationCommands(desired, actual)
    if (before.duplicateActualKeys.length > 0) {
      return yield* new ApplicationCommandInventoryInvalid({
        duplicateKeys: before.duplicateActualKeys,
        message: 'Discord returned duplicate command identities; refusing bulk replacement',
      })
    }
    if (before.hasChanges === false) return { changed: false as const, before, after: before }

    const replaced = yield* port.replace(scope, desired)
    const after = diffApplicationCommands(desired, replaced)
    if (after.hasChanges === true) {
      return yield* new ApplicationCommandResidualDrift({
        diff: after,
        message: 'Discord application commands still drift after bulk replacement',
      })
    }
    return { changed: true as const, before, after }
  }),
})

const desiredForScope = (scope: ApplicationCommandScope): ReadonlyArray<ApplicationCommand> =>
  scope._tag === 'GuildCommandScope'
    ? desiredApplicationCommands
    : desiredApplicationCommands.map((command) => ({
        ...command,
        integrationTypes: [0],
        contexts: [0],
      }))
