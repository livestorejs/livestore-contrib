import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import commonPkg from '../../../repos/livestore/packages/@livestore/common/package.json.genie.ts'
import livestorePkg from '../../../repos/livestore/packages/@livestore/livestore/package.json.genie.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/graphql'),
  dependencies: {
    workspace: [commonPkg, livestorePkg, utilsPkg],
    external: catalog.pick('@graphql-typed-document-node/core', '@opentelemetry/api'),
  },
  devDependencies: {
    external: catalog.pick('graphql'),
  },
  peerDependencies: {
    external: {
      ...getUtilsPeerDeps(),
      graphql: '^16.11.0',
    },
  },
})

export default packageJson(
  {
    name: '@livestore/graphql',
    ...livestorePackageDefaults,
    exports: {
      '.': './src/index.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/index.js',
      },
    },
    scripts: {
      test: "echo 'No tests'",
    },
  },
  runtimeDeps,
)
