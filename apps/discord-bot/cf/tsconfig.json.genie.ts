import { tsconfigJson } from '../../../repos/effect-utils/genie/external.ts'
import { discordBotCompilerOptions } from '../tsconfig.json.genie.ts'

// The CF project does not use the app's Effect language-service plugin.
const { plugins: _plugins, ...compilerOptions } = discordBotCompilerOptions

export default tsconfigJson({
  compilerOptions: {
    ...compilerOptions,
    types: ['@cloudflare/workers-types', 'node'],
  },
  include: ['**/*.ts'],
  exclude: ['node_modules', '**/dist', '**/node_modules/.pnpm', '**/*.genie.ts'],
})
