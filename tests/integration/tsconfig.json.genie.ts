import { baseTsconfigCompilerOptions, packageTsconfigExclude, tsconfigJson } from '../../genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    composite: true,
    exactOptionalPropertyTypes: false,
    outDir: './dist',
    rootDir: '.',
    resolveJsonModule: true,
    tsBuildInfoFile: './dist/.tsbuildinfo',
    types: ['@types/node'],
  },
  include: ['./src'],
  exclude: [...packageTsconfigExclude],
  references: [
    { path: '../../packages/@livestore/adapter-node' },
    { path: '../../packages/@livestore/devtools-vite' },
    { path: '../../repos/livestore/packages/@livestore/common' },
    { path: '../../repos/livestore/packages/@livestore/effect-playwright' },
    { path: '../../repos/livestore/packages/@livestore/livestore' },
    { path: '../../repos/livestore/packages/@livestore/sync-cf' },
    { path: '../../repos/livestore/packages/@livestore/utils' },
    { path: '../../repos/livestore/packages/@livestore/utils-dev' },
  ],
})
