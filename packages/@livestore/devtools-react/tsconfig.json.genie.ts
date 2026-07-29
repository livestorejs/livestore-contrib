import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  packageTsconfigExclude,
  reactJsx,
  refs,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    ...reactJsx,
    verbatimModuleSyntax: true,
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [
    // Contrib-local sibling, so a relative path rather than a `refs` entry —
    // `refs` only covers core packages materialized under `repos/livestore`.
    { path: '../devtools-common' },
    refs.adapterWeb,
    refs.common,
    refs.livestore,
    refs.react,
    refs.utils,
    refs.webmesh,
  ],
})
