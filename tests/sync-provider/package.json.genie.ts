import { catalog, effectDevDeps, localPackageDefaults, packageJson, workspaceMember } from '../../genie/repo.ts'
import adapterNodePkg from '../../packages/@livestore/adapter-node/package.json.genie.ts'
import devtoolsVitePkg from '../../packages/@livestore/devtools-vite/package.json.genie.ts'
import syncElectricPkg from '../../packages/@livestore/sync-electric/package.json.genie.ts'
import syncS2Pkg from '../../packages/@livestore/sync-s2/package.json.genie.ts'
import commonPkg from '../../repos/livestore/packages/@livestore/common/package.json.genie.ts'
import livestorePkg from '../../repos/livestore/packages/@livestore/livestore/package.json.genie.ts'
import sqliteWasmPkg from '../../repos/livestore/packages/@livestore/sqlite-wasm/package.json.genie.ts'
import utilsDevPkg from '../../repos/livestore/packages/@livestore/utils-dev/package.json.genie.ts'
import utilsPkg from '../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('tests/sync-provider'),
  dependencies: {
    workspace: [adapterNodePkg, commonPkg, livestorePkg, sqliteWasmPkg, syncElectricPkg, syncS2Pkg, utilsPkg],
    external: {
      postgres: '3.4.7',
    },
  },
  devDependencies: {
    workspace: [devtoolsVitePkg, utilsDevPkg],
    external: effectDevDeps('@types/node', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@local/tests-sync-provider',
    ...localPackageDefaults,
    exports: {
      './prepare-ci': './src/prepare-ci.ts',
      './registry': './src/providers/registry.ts',
    },
    scripts: {
      test: 'vitest run',
      'test:watch': 'vitest',
    },
  },
  runtimeDeps,
)
