import { catalog, effectDevDeps, localPackageDefaults, packageJson, workspaceMember } from '../../genie/repo.ts'
import adapterWebPkg from '../../packages/@livestore/adapter-web/package.json.genie.ts'
import commonPkg from '../../packages/@livestore/common/package.json.genie.ts'
import livestorePkg from '../../packages/@livestore/livestore/package.json.genie.ts'
import utilsDevPkg from '../../packages/@livestore/utils-dev/package.json.genie.ts'
import utilsPkg from '../../packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('tests/scenarios'),
  dependencies: {
    workspace: [adapterWebPkg, commonPkg, livestorePkg, utilsPkg],
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: effectDevDeps('@types/node', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@local/tests-scenarios',
    ...localPackageDefaults,
    scripts: {
      test: 'vitest run',
      'test:watch': 'vitest',
    },
  },
  runtimeDeps,
)
