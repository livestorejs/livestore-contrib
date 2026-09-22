import { Cli } from '@livestore/utils/node'

import { syncCommand } from './commands/import-export.ts'
import { mcpCommand } from './commands/mcp.ts'
import { createCommand } from './commands/new-project.ts'

export const command = Cli.Command.make('livestore', {
  verbose: Cli.Flag.Boolean('verbose').pipe(Cli.Flag.withDefault(false)),
}).pipe(Cli.Command.withSubcommands([mcpCommand, createCommand, syncCommand]))
