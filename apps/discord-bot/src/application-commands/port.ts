import type { Effect } from 'effect'

import type {
  ApplicationCommand,
  ApplicationCommandRestError,
  ApplicationCommandRemoteShapeUnsupported,
  ApplicationCommandScope,
  ApplicationCommandScopeRejected,
} from './model.ts'

export interface ApplicationCommandsPort {
  readonly list: (
    scope: ApplicationCommandScope,
  ) => Effect.Effect<
    ReadonlyArray<ApplicationCommand>,
    ApplicationCommandRestError | ApplicationCommandRemoteShapeUnsupported | ApplicationCommandScopeRejected
  >
  readonly replace: (
    scope: ApplicationCommandScope,
    commands: ReadonlyArray<ApplicationCommand>,
  ) => Effect.Effect<
    ReadonlyArray<ApplicationCommand>,
    ApplicationCommandRestError | ApplicationCommandRemoteShapeUnsupported | ApplicationCommandScopeRejected
  >
}
