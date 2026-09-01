import { baseTsconfigCompilerOptions, domLib, packageTsconfigExclude, tsconfigJson } from '../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    exactOptionalPropertyTypes: false,
    jsx: 'react-jsx',
    lib: [...domLib],
    outDir: './dist',
    rootDir: './src',
    resolveJsonModule: true,
    tsBuildInfoFile: './dist/.tsbuildinfo',
    types: ['vitest/globals', 'node'],
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [
    { path: '../../repos/livestore/packages/@livestore/adapter-web' },
    { path: '../../repos/livestore/packages/@livestore/common' },
    { path: '../../repos/livestore/packages/@livestore/livestore' },
    { path: '../../repos/livestore/packages/@livestore/sqlite-wasm' },
    { path: '../../repos/livestore/packages/@livestore/sync-cf' },
    { path: '../../repos/livestore/packages/@livestore/utils' },
    { path: '../../repos/livestore/packages/@livestore/utils-dev' },
  ],
})
