import { catalog, effectDevDeps, localPackageDefaults, packageJson, workspaceMember } from '../../genie/repo.ts'
import adapterWebPkg from '../../packages/@livestore/adapter-web/package.json.genie.ts'
import commonPkg from '../../packages/@livestore/common/package.json.genie.ts'
import effectPlaywrightPkg from '../../packages/@livestore/effect-playwright/package.json.genie.ts'
import livestorePkg from '../../packages/@livestore/livestore/package.json.genie.ts'
import syncCfPkg from '../../packages/@livestore/sync-cf/package.json.genie.ts'
import utilsDevPkg from '../../packages/@livestore/utils-dev/package.json.genie.ts'
import utilsPkg from '../../packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('tests/scenarios'),
  dependencies: {
    workspace: [adapterWebPkg, commonPkg, effectPlaywrightPkg, livestorePkg, syncCfPkg, utilsPkg],
    external: {
      ...catalog.pick('@cloudflare/workers-types'),
      '@playwright/test': '1.61.0',
    },
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...effectDevDeps('@types/node', 'vite', 'vitest'),
      tsx: '^4.20.0',
    },
  },
})

export default packageJson(
  {
    name: '@local/tests-scenarios',
    ...localPackageDefaults,
    scripts: {
      'scenario:run': 'tsx src/cli.ts',
      test: 'vitest run',
      'test:watch': 'vitest',
      viewer: 'pnpm exec vite --config scenario-viewer.vite.config.ts',
      'viewer:build': 'pnpm exec vite build --config scenario-viewer.vite.config.ts',
    },
  },
  runtimeDeps,
)
