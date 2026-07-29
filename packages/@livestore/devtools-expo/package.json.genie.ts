import {
  catalog,
  getUtilsPeerDeps,
  livestorePackageDefaults,
  packageJson,
  workspaceMember,
} from '../../../genie/repo.ts'
import utilsPkg from '../../../repos/livestore/packages/@livestore/utils/package.json.genie.ts'
import adapterNodePkg from '../adapter-node/package.json.genie.ts'
import devtoolsVitePkg from '../devtools-vite/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@livestore/devtools-expo'),
  dependencies: {
    workspace: [adapterNodePkg, utilsPkg],
  },
  devDependencies: {
    workspace: [devtoolsVitePkg],
    external: catalog.pick('@types/node', 'expo', 'vite'),
  },
  peerDependencies: {
    external: {
      ...getUtilsPeerDeps(),
      '@livestore/devtools-vite': devtoolsVitePkg.data.version,
      expo: '^54.0.12',
    },
  },
})

export default packageJson(
  {
    name: '@livestore/devtools-expo',
    ...livestorePackageDefaults,
    types: './dist/index.d.cts',
    main: './dist/index.cjs',
    peerDependenciesMeta: adapterNodePkg.data.peerDependenciesMeta,
    files: [...livestorePackageDefaults.files, 'expo-module.config.json', 'webui'],
    publishConfig: {
      access: 'public',
    },
    scripts: {
      test: 'echo No tests yet',
    },
  },
  runtimeDeps,
)
