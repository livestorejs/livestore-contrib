import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/devtools-common'),
  dependencies: {
    workspace: [utilsPkg],
  },
  peerDependencies: {
    external: getUtilsPeerDeps(),
  },
})

export default packageJson(
  {
    name: '@livestore/devtools-common',
    ...livestorePackageDefaults,
    types: './dist/index.d.ts',
    main: './dist/index.js',
    exports: {
      '.': './dist/index.js',
    },
    publishConfig: {
      access: 'public',
    },
    scripts: {
      test: 'echo No tests yet',
    },
  },
  runtimeDeps,
)
