import { baseTsconfigCompilerOptions, packageTsconfigExclude, tsconfigJson } from '../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    exactOptionalPropertyTypes: false,
    outDir: './dist',
    rootDir: './src',
    resolveJsonModule: true,
    tsBuildInfoFile: './dist/.tsbuildinfo',
    types: ['vitest/globals', '@types/node'],
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [
    { path: '../../repos/livestore/packages/@livestore/common' },
    { path: '../../repos/livestore/packages/@livestore/utils' },
    { path: '../../repos/livestore/packages/@livestore/utils-dev' },
    { path: '../../repos/livestore/packages/@livestore/sqlite-wasm' },
    { path: '../../packages/@livestore/adapter-node' },
    { path: '../../repos/livestore/packages/@livestore/adapter-web' },
    { path: '../../repos/livestore/packages/@livestore/livestore' },
  ],
})
