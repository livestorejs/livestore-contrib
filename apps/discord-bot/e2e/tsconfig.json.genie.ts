import { tsconfigJson } from '../../../repos/effect-utils/genie/external.ts'
import { discordBotCompilerOptions } from '../tsconfig.json.genie.ts'
import { packageTsconfigExclude } from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...discordBotCompilerOptions,
    types: ['node', 'vitest/globals'],
  },
  include: ['src/**/*.ts'],
  exclude: [...packageTsconfigExclude],
})
