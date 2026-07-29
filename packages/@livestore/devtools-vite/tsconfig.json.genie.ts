import {
  baseTsconfigCompilerOptions,
  packageTsconfigCompilerOptions,
  packageTsconfigExclude,
  refs,
  tsconfigJson,
} from '../../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    exactOptionalPropertyTypes: true,
    rootDir: './src',
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    erasableSyntaxOnly: true,
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [
    { path: '../devtools-react' },
    refs.adapterWeb,
    refs.common,
    refs.utils,
  ],
})
