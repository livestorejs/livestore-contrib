import { catalog, effectDevDeps, localPackageDefaults, packageJson, workspaceMember } from '../../genie/repo.ts'
import adapterNodePkg from '../../packages/@livestore/adapter-node/package.json.genie.ts'
import commonPkg from '../../repos/livestore/packages/@livestore/common/package.json.genie.ts'
import effectPlaywrightPkg from '../../repos/livestore/packages/@livestore/effect-playwright/package.json.genie.ts'
import livestorePkg from '../../repos/livestore/packages/@livestore/livestore/package.json.genie.ts'
import syncCfPkg from '../../repos/livestore/packages/@livestore/sync-cf/package.json.genie.ts'
import utilsDevPkg from '../../repos/livestore/packages/@livestore/utils-dev/package.json.genie.ts'
import utilsPkg from '../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('tests/integration'),
  dependencies: {
    workspace: [adapterNodePkg, commonPkg, effectPlaywrightPkg, livestorePkg, syncCfPkg, utilsPkg, utilsDevPkg],
    external: catalog.pick('@livestore/devtools-vite'),
  },
  devDependencies: {
    external: effectDevDeps('@playwright/test', '@types/node', 'vite', 'vitest', 'wrangler'),
  },
})

export default packageJson(
  {
    name: '@local/tests-integration',
    ...localPackageDefaults,
    scripts: {
      test: 'vitest run --config src/tests/node-misc/vitest.config.ts && vitest run --config src/tests/node-sync/vitest.config.ts',
    },
  },
  runtimeDeps,
)
