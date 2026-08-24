import {
  baseTsconfigCompilerOptions,
  tsconfigJson,
} from '../../repos/effect-utils/genie/external.ts'
import { packageTsconfigExclude } from '../../genie/repo.ts'

/** Use effect-utils' strict gate directly; contrib's temporary advisory waiver does not apply here. */
export const discordBotCompilerOptions = {
  ...baseTsconfigCompilerOptions,
  noEmit: true,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
  types: ['node'],
} as const

export default tsconfigJson({
  compilerOptions: discordBotCompilerOptions,
  include: ['src/**/*.ts'],
  exclude: [...packageTsconfigExclude],
})
